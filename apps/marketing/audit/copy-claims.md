# copy-claims.md - P10a read-only copy audit

Every checkable claim in the marketing page's visible copy, verified against the
product code on disk 2026-08-21 (components were being touched by P8 during the
read window; Hero.astro, Mission.astro and AgentLog.astro carry mtimes 01:38,
01:40 and 01:25 against the 01:21 batch for the rest - all line numbers below
are against the state as read, which is the latest on-disk state at audit time).
No repo file was modified by this audit.

## 1. FACTUAL CLAIMS

| # | Claim (as worded on the page) | Stated at | Verdict | Evidence in product code |
|---|---|---|---|---|
| 1 | "Every entry passes the same seventeen checks." | `src/components/sections/Checks.astro:13` | **FALSE** | The entry checklist is `ENTRY_CHECKS` in `apps/server/src/trading/TradingPreviewService.ts:442-457`, which has **14** items; the module's own doc comment says "the 14 checks, in spec order" (`TradingPreviewService.ts:190`). `PREVIEW_CHECKLIST_ITEMS` (`:38-68`) totals 16 (14 entry + 2 exit-only), which matches no reading of "17" either. |
| 2 | Lede enumerates the checks: "mission status, authority, agent lease, direction, signer approval, data freshness, size, price, exchange minimums, leverage, notional, per-position risk, the loss budget, pending conflicts, and the stop" | `src/components/sections/Checks.astro:15-18` | **FALSE (internal mismatch)** | That sentence names **15** things while the headline above it says 17 and the server runs 14 (`TradingPreviewService.ts:442-457`: mission_active, entries_allowed, harness_run_owns_lease, direction_permitted, execution_wallet_approved, account_and_bbo_fresh, size_and_price_valid, exchange_minimum_met, leverage_within_limits, gross_notional_within_authority, planned_loss_within_per_position_ceiling, reservations_plus_proposed_within_budget, no_conflicting_execution_pending, valid_stop_defined). "size" and "price" are one check (`size_and_price_valid`), not two. |
| 3 | Preview tally renders "N / 17" via `CHECK_COUNT` | `src/components/sections/Checks.astro:31-37`; `src/lib/mission.ts:330` (`export const CHECK_COUNT = 17`) | **FALSE** | Same 14-item `ENTRY_CHECKS` list. Fix: derive the count from the spec (14) or from the server constant, never a hand-typed 17. |
| 4 | "all seventeen passed" (preview verdict note) | `src/components/sections/Checks.astro:53` | **FALSE** | Same as row 1. |
| 5 | "Preview passed · order signed locally" with value "17/17" (agent-log fixture row) | `src/lib/mission.ts:246` | **FALSE** | Same 14-check list; visible in the replica log during the mission story. |
| 6 | Tape band aria-label "Hyperliquid testnet markets"; frontmatter comment "filled in from the Hyperliquid testnet API" | `src/components/sections/Tape.astro:10` (aria-label), `:2-3` (comment) | **FALSE** | The tape is filled from `https://api.hyperliquid.xyz/info` (`src/pages/index.astro:58`, comment at `:55` says "Real mids from the Hyperliquid **mainnet** API"), i.e. mainnet mids and mainnet 24h changes. The app itself trades testnet (`packages/hyperliquid/src/config.ts:15-17`, all testnet URLs). The page therefore shows mainnet prices under a "testnet" label. Safety-adjacent for a trading tool: either point the fetch at `api.hyperliquid-testnet.xyz` or label the band mainnet. |
| 7 | "T3 Trade drives five CLIs" | `src/components/sections/Harness.astro:27` | TRUE | Five adapters: ClaudeAdapter, CodexAdapter, CursorAdapter, GrokAdapter, OpenCodeAdapter (`apps/server/src/provider/Layers/`, registry in `ProviderAdapterRegistry.ts`); README table `README.md:108-112` lists the same five. |
| 8 | "Three of them can run trading missions today." (Claude Code, Codex, OpenCode tagged "trading missions"; Cursor and Grok "coding threads") | `src/components/sections/Harness.astro:27-28`, `:6-10`, `:57` | TRUE | `apps/server/src/trading/TradingMissionReactor.ts:294-303`: "The trading domain only knows three providers (§10.2): codex, claude, opencode." README `:108-112` marks Cursor and Grok "coding only". |
| 9 | Login commands: `claude auth login`, `codex login`, `opencode auth login`, `agent login`, `grok login` | `src/components/sections/Harness.astro:6-10` | TRUE | `README.md:108-112` lists the identical commands per CLI; `docs/user/providers-claude.md:20` confirms `claude auth login`. |
| 10 | "None of them ever receives the signer key." | `src/components/sections/Harness.astro:28-29` | TRUE | The key is read only by `InterimSignerConfig.ts` into server memory (`InterimSignerConfig.ts:37-39, 88-89`); a trading session's system prompt locks the harness to MCP trading tools only, "no shell, no filesystem" (`apps/server/src/provider/TradingSessionProfile.ts:119-123`). |
| 11 | "Execution needs one local testnet key." / "Put a single 32-byte EVM private key for a Hyperliquid testnet account in `~/.t3trade/secrets`" | `src/components/sections/Arming.astro:10-15` | TRUE | `apps/server/src/trading/InterimSignerConfig.ts:12-23`: 0x-prefixed 32-byte hex EVM key, read from `~/.t3trade/secrets/hyperliquid-interim-signer-key.bin` when env unset; exchange endpoints are testnet (`packages/hyperliquid/src/config.ts:15-17`). |
| 12 | "T3 Trade derives the address, holds the raw key in server memory, and signs orders locally with it." | `src/components/sections/Arming.astro:13-15` | TRUE | `InterimSignerConfig.ts:138` (`addressFromPrivateKey`), `:149` (raw bytes kept in the service), `:37-38` ("held as raw bytes in memory and never persisted"); signing happens in the local SDK before the testnet POST (`packages/hyperliquid/src/`). |
| 13 | "The key is never written to logs, reports, or the database." | `src/components/sections/Arming.astro:15` | TRUE (as far as code shows) | `InterimSignerConfig.ts:88` "Never logged, never persisted"; `:37` "never touches `trading_accounts.master_wallet_json`". Verified for this module; a whole-repo proof that no other writer logs the key is not mechanically checkable, but no counterexample exists in `apps/server/src` or `packages/`. |
| 14 | "No valid signer key → Execution is disabled. Every action that needs a signature is rejected." | `src/components/sections/Arming.astro:22-25` | TRUE | `InterimSignerConfig.ts:32-34`: key absent → signer resolves `Option.none()` and every signable action is rejected with `interim_signer_not_configured` (fail closed by design). |
| 15 | "Every position increase carries a stop. T3 Trade submits an exchange-native reduce-only stop, then reconciles its size against the position Hyperliquid reports." | `src/components/sections/Checks.astro:21` | TRUE | `valid_stop_defined` entry check (`TradingPreviewService.ts:428`); reduce-only orders throughout `apps/server/src/trading/HyperliquidExecutionService.ts:1023,1130`; reconciliation in `HyperliquidReconciler.ts` and `TradingPlanProtectionService.ts` (grep "reconcil" over `apps/server/src/trading`). |
| 16 | "A retry is the same order. The client order ID and local request key are deterministic, so a resubmission cannot open a second position." | `src/components/sections/Checks.astro:22` | TRUE | `HyperliquidExecutionService.ts:243`: "parent and child get distinct **deterministic cloids**"; deterministic controls noted at `:154`. |
| 17 | "You keep the controls. Pause, cancel entries, reduce, close, and revoke all work with the agent CLI stopped." | `src/components/sections/Checks.astro:23` | TRUE | `packages/contracts/src/trading.ts:400-407`: risk controls are "invokes them directly - no harness turn, and availability that does not depend on the bound harness being online"; controls `cancel_entries, reduce_position, close_position, close_and_revoke` (`:408-413`), reductions include 50 (`:417`); Pause/entries-paused in `apps/web/src/components/trading/tradingPresentation.ts:17,499`. |
| 18 | "Positions, orders, and fills are re-read from Hyperliquid after every submission, fill, reconnect, and restart." | `src/components/sections/Mission.astro:47-49` | TRUE | `apps/server/src/trading/HyperliquidReconciler.ts:11`: "The eight triggers (§18.2): at server startup, after WebSocket reconnect, ..." (plus post-submission/post-fill triggers listed there); `TradingFillReconciler.ts` exists alongside. |
| 19 | "Local records never override it." | `src/components/sections/Mission.astro:49` | TRUE | Reconciler design (`HyperliquidReconciler.ts:11` onward) is exchange-authoritative; see also `docs/architecture/trading-execution.md` (linked from the page and present in-repo). |
| 20 | "Realised loss, paid fees, protected open risk, and pending-entry risk all draw down the same budget. Exhaust it and new exposure is blocked while stops stay in place." | `src/components/sections/Mission.astro:56-58` | TRUE | `packages/trading-contracts/src/lossAccounting.ts`: eq 1-2 realised loss incl. fees (`:107-111`), `pendingEntryRisk` (`:63-76`), eq 5 budget = realised + open + pending (`:118`); new exposure blocked by `reservations_plus_proposed_within_budget` entry check (`TradingPreviewService.ts:391`), while exits have their own checklist that deliberately drops the budget row (`TradingPreviewService.ts:471-479`). |
| 21 | "It rests on Hyperliquid as a reduce-only order... It survives the app closing." | `src/components/sections/Mission.astro:66-69` | TRUE | Reduce-only stop orders are live exchange orders (`HyperliquidExecutionService.ts:1023` reduceOnly exit); an order resting on the exchange is by construction independent of the app process. |
| 22 | "replaying a testnet BTC run" | `src/components/sections/Mission.astro:19-21` | **UNVERIFIABLE** | The fixture documents its own provenance ("the levels are the record... rewritten against the live spot, Coinbase BTC-USD, 2026-08-21", `src/lib/mission.ts:16-21`), but no testnet run record ships in the repo to cross-check the levels against. To verify: export the mission/run record (exchange fill or journal export) the fixture claims to transcribe and diff the levels. Not safety-critical: the page labels the capture separately as "a fixed example". |
| 23 | Hero eyebrow "Open source alpha, Hyperliquid testnet" | `src/components/sections/Hero.astro:20` | TRUE | MIT `LICENSE` at repo root; testnet-only endpoints `packages/hyperliquid/src/config.ts:15-17`; alpha per README and release tooling. |
| 24 | Hero sub "T3 Trade holds it to hard limits and signs every order locally." | `src/components/sections/Hero.astro:26-29` | TRUE | Loss ceiling (`lossAccounting.ts:98-118`) enforced by the entry checklist; local signing per rows 12-13. |
| 25 | Meta/OG description: "open-source desktop and self-hosted web app for supervised perp trading with coding agents on Hyperliquid testnet." | `src/layouts/Layout.astro:13-14` (also og:description `:27`) | TRUE | Desktop app (`apps/desktop`, packaged per `scripts/build-desktop-artifact.ts`), web app from source (`apps/web`), testnet-only per row 23; "supervised" matches the operator-control and wakeup design (`contracts/trading.ts:400-407`, `TradingSessionProfile.ts`). |
| 26 | "What ships in this alpha": "Trading missions on Claude Code, Codex, and OpenCode"; "Hyperliquid testnet orders under fixed authority and a USD loss limit"; "Required reduce-only stops, exchange reconciliation, retry-safe submission"; "An Apple Silicon macOS app and a self-hosted web app run from source" | `src/components/sections/State.astro:14-17` | TRUE | Rows 8, 20, 15/16, 18 above; Apple-Silicon-only enforced by `scripts/install-macos.sh:29` ("the published build is Apple Silicon only; run from source on an Intel Mac") and arm64 asset selection in the same script. |
| 27 | "Not today": "No mainnet support of any kind"; "No packaged Windows, Linux, or Intel Mac builds"; "No wallet onboarding, only the local testnet key"; "No mobile app and no unattended trading with real funds" | `src/components/sections/State.astro:23-26` | TRUE | Only testnet URLs exist in the live trading stack (`packages/hyperliquid/src/config.ts`); the sole mainnet URL in the server sits in `apps/server/src/trading/archive/config.ts` (archived, not wired); platform gates in `install-macos.sh:28-29`; no wallet onboarding - Privy is future work ("Privy replaces this in PROMPT-06", `InterimSignerConfig.ts:7-8`); no `apps/mobile` trading surface. |
| 28 | Footer "T3 Trade, MIT licensed, alpha software, Hyperliquid testnet only" | `src/layouts/Layout.astro:102` | TRUE | `LICENSE` (MIT, T3 Tools Inc.); testnet-only per rows 23/27. |
| 29 | Nav tag "live · alpha" | `src/layouts/Layout.astro:76` | TRUE (status label) | Alpha per README; "live" refers to the product being live software; not a fake-availability claim. |
| 30 | "Built on T3 Code... MIT-licensed fork of T3 Code, Ping Labs' open-source interface for coding agents." | `src/components/sections/Open.astro:16-18`; link `src/lib/site.ts:3` (pingdotgg/t3code) | TRUE | Fork of `pingdotgg/t3code` per repo history and `docs/upstream/`; MIT per root LICENSE; T3 Code is Ping Labs' (Theo/pingdotgg). |
| 31 | "records every intentional fork change in `PATCH_LEDGER.md`" | `src/components/sections/Open.astro:18-19` | TRUE (path nuance) | The ledger exists at `docs/upstream/PATCH_LEDGER.md` (not repo root). The copy names the file without a path and without a link; consider linking to the actual path so the claim is one click checkable. |
| 32 | "Read the execution design" link | `src/components/sections/Open.astro:23` | TRUE | `docs/architecture/trading-execution.md` exists in-repo; URL `${GITHUB_REPOSITORY_URL}/blob/main/docs/architecture/trading-execution.md` resolves on GitHub. |
| 33 | CTA: "The macOS build is Apple Silicon only and is not notarized, so a downloaded copy is quarantined and macOS may refuse to open it. The installer above fetches the same DMG and clears that flag." | `src/components/sections/Cta.astro:25-29` | TRUE | `scripts/install-macos.sh:5-17` states the notarization/quarantine behavior and the script removes the flag; `scripts/lib/adhoc-sign-mac.cjs:19-21` confirms builds are ad-hoc signed, not notarized. |
| 34 | `xattr -dr com.apple.quarantine "/Applications/T3 Trade (Alpha).app"` | `src/components/sections/Cta.astro:30` | TRUE | `install-macos.sh:23` `APP_NAME="T3 Trade (Alpha).app"` matches exactly. |
| 35 | Install one-liner `curl -fsSL .../main/scripts/install-macos.sh | bash` | `src/components/sections/Cta.astro:23` | TRUE | `scripts/install-macos.sh:17` carries the identical command as its documented usage. |
| 36 | Release line "`<tag>` · macOS arm64, not notarized" (hidden until fetch) and download buttons resolving to the `-arm64.dmg` asset | `src/components/sections/Cta.astro:18-20`; `src/pages/index.astro:40-44` | TRUE in code, **stale live state** | Asset match `a.name.endsWith("-arm64.dmg")` matches the installer's selection (`install-macos.sh:40`). But the GitHub releases list for TaraxioT/t3trade is currently **empty** (API `releases?per_page=2` returned `[]` on 2026-08-21), so both download buttons silently fall back to the releases page (`index.astro:49-52`), which has nothing to download. The copy around the buttons is accurate; the distribution is not. Flag to whoever owns releases. |
| 37 | Capture section: "Not a mockup. The panel itself."; "A screenshot of T3 Trade running: the mission panel mid-trade..." and the caption "The real mission panel, captured at 2x from the running app in dark mode, desktop and mobile widths. The mission shown is a fixed example." | `src/components/sections/Capture.astro:8-12, 37-40` | TRUE | Assets exist under `apps/marketing/public/capture/` (avif+webp, desktop and mobile variants, produced by `orchestration/p7/capture.mjs`); agy-vision read of `mission-live-panel-desktop.webp` confirms a real app panel (agent log, chart with target 1,878.2 / stop 1,858.1, 5x long position). |
| 38 | Capture alt text: "ETH/USD at 1,869.4 (+1.84%)... 5x leveraged long positions... target and stop levels... agent log" | `src/components/sections/Capture.astro:30` | TRUE | agy-vision transcription of the desktop capture returned exactly: ETH/USD, 1,869.4, +1.84%, ETH 5x Long, target 1,878.2 and stop 1,858.1 visible, agent log visible. |
| 39 | Replica composer chip "GPT-5.6-Luna" | `src/lib/mission.ts:326` (rendered `Composer.astro:38`) | TRUE (plausible fixture) | "Luna" is the product's real default text-generation model family (`packages/contracts/src/settings.test.ts:119`: "defaults text generation to Luna"); "GPT-5.6" naming matches the web app's model slugs (`apps/web/src/components/chat/ContextWindowMeter.logic.test.ts:17`, "GPT-5.6 Sol"). Fixture inside an aria-hidden replica. |
| 40 | "Older builds and checksums are on the releases page." | `src/components/sections/Cta.astro:32-33` | TRUE as a link, hollow today | URL is the real releases page; as of 2026-08-21 that page lists zero releases (see row 36). |
| 41 | CTA sub: "Install a supported agent CLI, add a testnet-only signer key, pick a perp, and type your mandate." | `src/components/sections/Cta.astro:9-11` | TRUE | Matches the actual flow: BYO CLI (README:108-112), `~/.t3trade/secrets` key (row 11), perp markets on testnet (`packages/hyperliquid`), mission mandate (contracts/trading.ts). |

### Safety-adjacent summary

The tape mislabel (row 6) and the checks count (rows 1-5) are the two defects
that matter for a trading landing page. Everything safety-critical that could be
checked - fail-closed signer, local signing, key never persisted, exchange-side
stops, reconciliation triggers, budget math, controls without the harness -
checks out true with file:line evidence. Row 22 (fixture provenance) is the one
UNVERIFIABLE item; it needs an exported run record to close.

## 2. STRING DEFECTS

| # | Current string | Where | Problem | Proposed rewrite |
|---|---|---|---|---|
| 1 | "This is the cockpit itself, replaying a testnet BTC run: keep scrolling and the log fills, the watch fires, the checks pass, and the chart earns its target." | `src/components/sections/Mission.astro:19-22` | Two defects in one sentence: a scroll cue ("keep scrolling...", banned by DESIGN-CONTRACT clause 6 and already flagged in audit/slop.md row 8) and the metaphor "the chart earns its target", which is LLM-performed poetry, not information (slop.md row 17). "The watch" is also product jargon on first mention. | "This is the cockpit itself, replaying a testnet BTC run from trigger to target: the log fills, the entry checks pass, the stop rests on the exchange, and the position closes at the target." (Replaces the instruction with what the replay contains; every clause is a verifiable product behavior; no scroll direction.) |
| 2 | "Every entry passes the same seventeen checks." | `src/components/sections/Checks.astro:13` | False count (14, not 17; see factual rows 1-5). | "Every entry passes the same fourteen checks." Better: stop hardcoding the number at all: "Every entry passes the same gate of checks before it is signed." If the number stays, derive it from the spec constant rather than a literal. |
| 3 | "...mission status, authority, agent lease, direction, signer approval, data freshness, size, price, exchange minimums, leverage, notional, per-position risk, the loss budget, pending conflicts, and the stop. One failure rejects the order." | `src/components/sections/Checks.astro:15-18` | The enumeration names 15 items under a headline of 17, and the server list is 14; "size, price" are one check. | "Before signing a position-increasing order, T3 Trade re-checks the mission, its authority, the agent lease, direction, signer approval, data freshness, size and price, exchange minimums, leverage, notional, per-position risk, the loss budget, pending conflicts, and the stop. One failure rejects the order." (14 comma-groups, matching the server list one-to-one; "size and price" joined.) |
| 4 | "all seventeen passed" | `src/components/sections/Checks.astro:53` | False count. | "all fourteen passed" or, if `CHECK_COUNT` is fixed in `mission.ts`, `all {CHECK_COUNT} passed` rendered from the fixture so it can never drift again. |
| 5 | `CHECK_COUNT = 17` and the log row value "17/17" | `src/lib/mission.ts:330`; `:246` | False count in the fixture the contract says every replica number traces to; the drift source for rows 2-4. | Set `CHECK_COUNT = 14` with a comment pointing at `ENTRY_CHECKS` in `TradingPreviewService.ts` as the source of truth; the log row derives from the constant. |
| 6 | aria-label "Hyperliquid testnet markets" | `src/components/sections/Tape.astro:10` | Labels mainnet prices as testnet (factual row 6). | Either fetch `https://api.hyperliquid-testnet.xyz/info` and keep the label, or keep mainnet data and label it "Hyperliquid markets" (mainnet prices are the honest choice for a ticker: testnet mids are thin and meaningless). Update the stale frontmatter comment at `Tape.astro:2-5` to match whichever is chosen. |
| 7 | "records every intentional fork change in PATCH_LEDGER.md" | `src/components/sections/Open.astro:18-19` | Referent is slightly off: the file lives at `docs/upstream/PATCH_LEDGER.md`, and the claim is not linked, so a reader cannot check it. | "records every intentional fork change in its patch ledger" with the words linked to `docs/upstream/PATCH_LEDGER.md` on GitHub. |
| 8 | "The stop is not advisory" | `src/components/sections/Mission.astro:63` | Judged borderline in audit/slop.md row 17 ("punchy but plain enough to keep"). It is load-bearing and precise (the stop is an exchange order, not a suggestion), so the verdict here is: keep. Listed so the decision is on record rather than silently inherited. | Keep as-is. |
| 9 | "keep scrolling and the log fills..." scroll-cue fragment inside the Mission lede | (same string as defect 1; the near-duplicate eyebrow situation noted in the mission brief was already fixed and is not present in the current files: hero eyebrow is "Open source alpha, Hyperliquid testnet" at `Hero.astro:20`, the only other `.eyebrow`-class use is the section label in Checks, and no near-duplicate pair exists) | n/a | n/a - recorded as verified-fixed. |

No other visible string on the page is grammatically broken, referent-blind, or
reads as decoration rather than information. The rail-list items, arming band,
state pane, capture copy, and CTA notes are all plain declaratives that match
the product.

## 3. DASH AND REGISTER SWEEP

**Em-dashes (`—`): 14 total** in `apps/marketing/src` (astro + ts + css), down
from the historical 22 (the monolithic `index.astro` was split into components
and most comment dashes went with it). Classified:

- Comments only: 14 of 14. `Chart.astro` 6 (`:80, :108, :670, :781, :846, :862`), `Composer.astro` 3 (`:194, :211, :273`), `Positions.astro` 2 (`:121` and one more in its style block), `Tape.astro` 1 (`:49`), `AgentLog.astro` 1 (`:43`), `styles/replica.css` 1 (`:200`).
- Visible strings: **0**. Every hit sits inside `/* */`, `//`, or `<!-- -->` context; none reaches the rendered DOM.

**En-dashes (`–`) as separators: 0** anywhere in `apps/marketing/src`.

Non-negotiable 1 of DESIGN-CONTRACT.md holds: zero em-dash and zero
en-dash-as-separator in any visible string. The 14 comment dashes are a
hygiene note only, same verdict as slop.md row 1.

**Register verdict.** The contract names the language "dark-tech precision
instrument", and the page's strongest strings are exactly that register:
technical mono with checkable content ("Reduce-only stop resting on-exchange",
"Preview passed · order signed locally", "17/17" style tallies, the tape).
That is the register the page should keep. Two strings sit outside it:

1. "the chart earns its target" (`Mission.astro:21`) - editorial metaphor;
   rewrite proposed in defect 1.
2. "keep scrolling and the log fills..." (`Mission.astro:20-21`) - conversational
   instruction, not instrument copy; removed by the same rewrite.

Borderline but acceptable: "The stop is not advisory" (punch, but every word is
literally true and the sentence carries the section's claim) and "Open all the
way down." (marketing punch in a headline slot, consistent with github.com's
own homepage voice, which is the contract's stated reference standard). The
mission-notes trio ("The exchange is the source of truth" and siblings) is
declarative technical prose and fits. After defect 1's rewrite lands, the page
speaks one register.

## Counts

- Table 1: 41 factual rows - 33 TRUE, 5 FALSE (rows 1-5, all one root cause:
  the checks count), 1 FALSE mislabel (row 6, the tape), 1 UNVERIFIABLE (row
  22), 1 TRUE-with-live-state-warning (row 36; row 40 noted alongside).
- Table 2: 8 rows - 7 proposed rewrites, 1 keep-on-record, 1 verified-fixed.
- Table 3: 14 em-dashes (all comments), 0 en-dashes, 0 in visible strings; 2
  strings outside register.

## Not checked / limits

- Rendered-browser confirmation (static analysis plus one agy-vision pass on
  the capture image, per DESIGN-CONTRACT's image rule). No dev server, browser,
  or git changes were made.
- GitHub live state was read once via the public API (releases list empty);
  if releases appear later, factual rows 36/40 flip to routine-true.
- The testnet run behind the mission fixture (row 22) cannot be verified from
  the repo; it needs the run record the fixture claims to transcribe.
