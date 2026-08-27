# Trading final form — verification log

Iterative verification of the landed phases in `trading-final-form.md`, against
`main` only. Each round is one dated section; findings carry severity, repro,
and file pointers. Evidence (screenshots, DB dumps) lives under
`evidence/final-form/` at the repo root (local, not committed).

Method: a detached worktree at the verified commit (`t3trade-verify-main`),
its own `.t3` state, one dev server and one controlled browser for the whole
loop. Server-side facts read from the dev-runner log, the SQLite files, and
`ps`/`lsof`; UI facts read in the paired browser.

## Round 1 — 2026-08-27 — Archiver v2 (Phase 2)

Commit under test: `f103fc78e` (all of phases 0–7 are on `main`; 8–9 not
started). Fresh state boot (empty `.t3`), server 16320 / web 8280.

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Fresh state boots the archiver | Pass | dev log `ArchiveSupervisor: archiver started {pid 81126}` at 17:41:10, 0s after listen; child `node …/trading/archive/main.ts` under server pid 80726 |
| kill -9 → respawn with backoff | Pass | `kill -9 81126` at 17:46:01 → `WARN archiver failed` (SIGKILL cause) 17:46:01.688 → `archiver started {pid 84682}` 17:46:03.697 — 2.0s, the `BACKOFF_BASE` after a run longer than `HEALTHY_AFTER`; UI later showed "restarted 1× since boot" |
| WS candles flowing | Pass | archiver child holds an ESTABLISHED TLS session to `api.hyperliquid.xyz` (CloudFront edge); fresh 1m bars land every minute (`MAX(t)` tracks wall clock); writer-lock lease heartbeat fresh within its 10s interval |
| Follow a new asset → backfill ≤ ~1 min | Pass | SOL added to watchlist 17:48:00 → follow file published 17:48:29 (`PUBLISH_INTERVAL_MS` 30s) → 32,174 bars across all 7 intervals by 17:48:46 (46s end to end) |
| Archive file is schema v2, venue populated | Pass | `meta.schema_version = "2"`; `candles(venue, coin, interval, t, …)` with `venue='hyperliquid'` on every row; cold start seeded BTC+ETH (~5k bars × 7 intervals each) |

Cold-start behavior matches the design: the server writes
`{"followed":[]}` and the archiver substitutes `DEFAULT_SEED_COINS`
(BTC/ETH) until a real follow set exists (`archive/config.ts:66-89`). After
SOL was followed, the follow file became the sole source and BTC/ETH stopped
being recorded — attention-driven, as specified.

### Findings

- **[Low] R1-1 — Archiver health changes ring no bell.** The trade home's
  account view refreshes only on the account doorbell
  (`apps/web/src/lib/tradingAccountState.ts:6-11`, "no poll intervals … by
  design"). A supervisor crash/respawn is not a trading event, so the health
  line stays stale indefinitely on an otherwise-idle account. Observed: the
  archiver was killed at 17:46:01; "Market recording is running (restarted
  1×)" only appeared at 17:48:0x after an unrelated watchlist edit rang the
  doorbell. The mission snapshot's 30s backstop does not cover the account
  view. Repro: fresh state → trade home → `kill -9` the archiver child →
  the health line never changes until a trading event occurs.
- **[Info] R1-2 — Signal deaths log as `failed`, not `exited`.** A SIGKILLed
  child makes `child.exitCode` throw, so the supervisor logs
  `WARN archiver failed {cause: … SIGKILL}` rather than
  `archiver exited {code}` (`apps/server/src/trading/ArchiveSupervisor.ts:152`).
  Handling is identical (restart + backoff); wording only.
- **[Medium] R1-3 — Phantom draft tab crashes on fresh state.** Within a
  minute of pairing on fresh state, a second tab appeared at
  `/draft/d0afc345-…` (title "T3 Trade (Alpha)") that I did not open, and it
  crashed ~18s in: error boundary "Base UI: SelectRootContext is missing.
  Select parts must be placed within <Select.Root>" in `<SelectTrigger>`,
  TanStack route match `__root__/`. Console log:
  `evidence/final-form/` (copy of `.playwright-mcp/console-2026-08-27T12-12-38-844Z.log`).
  What opened the tab is unidentified (no window.open on the draft path;
  `ChatView.tsx:1976-2013` only `navigate`s). Re-verified deliberately in
  Round 3 — see R3 findings before treating the opener as a bug.

### Verdict

Archiver v2 is solid: supervision, backoff, WS-first collection, follow-set
control, and the v2 schema all behave exactly as the plan describes, with
sub-minute backfill on a new follow. The one behavioral gap worth a look is
R1-1 (archiver health is not eventually-consistent in the UI); R1-3 is a
real crash waiting for a repro before it's actionable.

## Round 2 — 2026-08-27 — Account read model + push (Phase 3)

Environment: worktree re-seeded from `~/.t3trade/dev` (state of Aug 22,
pre-074) plus the real `market-archive.sqlite`. On boot, migrations
`74_TradingWatchlistAlerts` and `75_TradingManualExecution` ran cleanly over
the seeded data (dev-runner log 17:56:37; Round 6 examines the rows further).
23 missions / 100 threads / 16 projects came over; the interim signer key is
machine-shared (`~/.t3trade/secrets`, `packages/hyperliquid/src/KeyLocation.ts`),
so the worktree server trades on the funded testnet account ($869.91).

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Fill → positions ≤ ~1s, no polling | Pass | order command 18:06:55.105 (`orchestration.command.trading.order.place`), IOC filled 18:06:59.8 (userFills), doorbell ring → `getTradingAccountView` refetch 18:07:00.472 (0.67s after the fill), position rendered with provenance `Stop on exchange` + authority `Manual`; outcome alert "Manual buy 0.2 HYPE filled @ 60.3 (stop 54)" in the feed at 18:07:00. The exchange-side liquidation ~3 min later also converged to "No open positions" via the 5s manual reconcile pass |
| No 3s polling (30s fallback allowed) | Pass with finding | idle 69s window: **0** `getTradingAccountView` calls; one refetch burst per doorbell ring (watchlist edit at 12:34:49 → exactly one call each from the four read hooks). But the **mission snapshot** is still 3s-polled by the app sidebar — R2-1 |
| Doorbell invalidations visible | Pass | `addTradingWatchlistEntry` → single refetch of account view/watchlist/watches/alerts 60ms later (trace `server.trace.ndjson`); external liquidation converged the same way |

### Findings

- **[Medium] R2-1 — the 3s poll lives on in the sidebar.**
  `apps/web/src/components/Sidebar.tsx:1861` runs
  `window.setInterval(refreshMissionSnapshot, 3_000)` on every page (the
  sidebar is always mounted): 26 `getTradingMissionSnapshot` RPCs in a 69s
  idle window, exactly +3.00s apart. The final form retired the 3s poll
  (`tradingMissionsState.ts` moved to doorbell + 30s backstop); the sidebar's
  copy — and its comment "the projection is pull-only", which is no longer
  true — survived. On remote/tunnel links this is exactly the websocket
  chattiness the workspace tries to avoid, and the snapshot carries all 23
  missions each call.
- **[High] R2-2 — manual Close fails while its mandatory stop rests.**
  0.2 HYPE long with a resting reduce-only stop @ trigger 54; Close clicked
  18:08:41. Both reduce-only IOC attempts were rejected by the exchange
  (18:08:43.340 and 18:08:44.664, `outcomes: ['error']`), the position stayed
  open, and the panel reported "Position partly closed; 0.2 HYPE remains" —
  false at the time. `closeManualPosition`
  (`apps/server/src/trading/TradingControlService.ts:461-536`) never cancels
  the resting stop before selling reduce-only; the suspected rejection is the
  exchange's aggregate reduce-only check (0.2 resting stop + 0.2 new sell >
  0.2 position). The position was then liquidated externally ~75s later
  (18:09:57, `Liquidated Isolated Long 0.2 @ 60.0`, −$1.20). Repro: enter
  with a stop from the order ticket, click Close, watch the wire log.
  Round 6 pins the exchange's rejection reason.
- **[Low] R2-3 — the exchange's rejection reason is dropped.**
  `HyperliquidExecutionService.ts:1241-1245` logs
  `outcomes: outcome.statuses.map(row => row.outcome)` but discards
  `row.reason`, so a rejected reduce-only exit leaves only `['error']` in the
  log. R2-2 could not be root-caused from the server's own logs for this
  reason.
- **[High] R2-4 — balance is frozen for a missionless account.**
  The account view's balance is the latest per-mission row in
  `trading_account_observations`
  (`TradingAccountProjection.ts:188-217` "the account's balance is its most
  recently observed mission's row"); observations are written only by the
  mission reconciler (`HyperliquidReconciler.ts:969-982`, keyed by
  `mission_id`). With no active mission nothing writes one — the latest row in
  the seeded DB is from **Aug 20** (891.70), and the UI showed "$892" all
  session while the true balance moved 869.91 → 868.71 through a fill and a
  liquidation. Positions push correctly; the balance is a static number.
- **[High] R2-5 — manual entries inherit the account's isolated margin mode
  and were liquidated at flat price.** The manual entry path never sets or
  checks margin mode; the interim account's per-asset mode is isolated from
  its mission era, and the fresh HYPE position was liquidated by the exchange
  ~3 minutes after entry at a $1.20 loss with price ≈ flat (60 in, 60 out) —
  before the stop could ever matter. The fork's protection doctrine (every
  entry carries a stop) is not backed by margin-mode awareness. Needs a
  Round 6 reproduction with leverage read out.

### Verdict

The push architecture is real and fast — doorbell, single-refetch-per-ring,
sub-second fill visibility, no account polling. What it pushes, however,
partly rots at the edges for the missionless trader the final form is built
for: the balance never updates (R2-4), the mission snapshot is still 3s-polled
by the sidebar (R2-1), and the round's fill test uncovered that manual close
is broken whenever the mandatory stop rests (R2-2) with an exchange-side
liquidation as the exit of last resort (R2-5). Phase 3's mechanism passes;
phases 3+7's promise to the human trader only half-lands.

## Round 3 — 2026-08-27 — Trade home (Phase 4)

Same seeded environment. Screenshots: `evidence/final-form/r3-trade-home-light.png`,
`r3-trade-home-dark.png` (analyzed with agy-vision).

| Acceptance | Result | Evidence |
| --- | --- | --- |
| Fresh launch opens /trade | Pass | observed three times (both boot pairings land on `/trade`; with the toggle on, `/` redirects to `/trade`, `routes/_chat.index.tsx:42-46`) |
| `openOnTradeHome` off → classic draft landing | **Fail** | toggle at `settings/trading` ("Open on the trade home") persists; with it off, `/` lands on `/draft/<uuid>` — which crashes 100% of the time (R3-1) |
| Universe search adds any Hyperliquid asset; recording starts | Pass | SOL on the fresh boot (R1: follow published ≤30s, 32k bars in 46s) and HYPE on the seed (watchlist row live, chart entitled, follow set carrying it). Removal is the reverse state and works: row gone + `trading_watchlist` empty, HYPE stayed followed only via the recent-chart decay window — D2's union behaving as designed. The seed's wake watches (52 active legacy rows, `deliver='wake'` backfilled by 074) pulled BTC/ETH back into recording |
| Positions show provenance + authority labels | Pass (manual arm only) | "Stop on exchange" (D5 provenance) + "Manual" (authority) seen in R2. The mission-authority arm was not observable: the seeded account is flat and all 23 missions are settled/revoked |
| Coding threads reachable from sidebar/palette | Partial | existing threads open from the sidebar and from the palette's "Recent Threads" (opened "Hi there" cleanly); the palette carries the "Open trade home" action and it works. But **creating** a new thread crashes (R3-1) |

### Findings

- **[Critical] R3-1 — the draft landing hard-crashes; new coding threads
  cannot be created.** Every fresh draft (`/draft/<uuid>`) dies with the
  full-page error boundary: "Base UI: SelectRootContext is missing. Select
  parts must be placed within <Select.Root>". Reproduced three ways: (a)
  toggle `openOnTradeHome` off and open `/`; (b) "New thread" → pick any
  project in the palette; (c) Round 1's phantom tab on first pairing — that
  unexplained tab was the app auto-opening a draft landing, crashing. Root
  cause: `TradingAssetPicker` uses
  `<ComboboxTrigger render={<ComposerSelectControl …/>}>`
  (`apps/web/src/components/trading/TradingAssetPicker.tsx`, trigger at the
  `AssetCombobox` return; `ComposerSelectControl` extends Base UI
  `SelectTrigger`, `apps/web/src/components/chat/ComposerControl.tsx:60-70`),
  mounted unconditionally into the draft composer footer by
  `ChatView.tsx:6597-6608`. A Select trigger rendered under a Combobox root
  throws for want of `Select.Root`. Trading-first dogfooding never opens a
  draft, so it shipped. This breaks: the toggle-off landing, New thread from
  the sidebar, and the draft-hero mission-claiming path Phase 8 plans to
  retire.
- **[Low] R3-2 — chart Y-axis label collision and raw price precision.**
  In the light screenshot the session-level tag `vwap 82.13` overlaps the
  axis label `80.81882328` (8 decimals, no tick rounding) on the HYPE 1m
  chart. Cosmetic, but the 8-decimal label suggests the axis formatter
  misses HYPE's tick size. `MarketChartPanel.tsx` price gutter; revisit in
  Round 5.
- **[Info] R3-3 — "Go to threads" is a no-op while trading-first is on.**
  The logo link navigates to `/`, which the index route immediately
  redirects back to `/trade` when `openOnTradeHome` is on (clicked; observed
  bounce-back at 12:51). Threads are reachable only via thread rows or the
  palette.
- **[Note] R3-4 — sidebar title truncation is seed data, not UI.** The
  "rade ETH on the 1m…" row is stored truncated in `projection_threads`
  (verified by query); no UI defect.

### Verdict

The trade home itself is right: trading-first landing, honest empty states,
universe search that starts recording, watchlist round-trip, palette
integration, and the provenance/authority vocabulary — all present and
working in both themes (one cosmetic chart-label overlap). But the round
found the most severe defect of the whole verification: the classic draft
landing — the explicit off-path of the phase's own headline feature — and
with it all new-thread creation, crashes on main. Phase 4's checkbox says
"landed"; its acceptance path "toggle off → classic draft landing" cannot be
walked by a user.

## Round 4 — 2026-08-27 — Alerts (Phase 5)

Same environment, plus: the dev server was restarted with
`T3_TRADES_AUTO_MISSION=1`, capital `$60`, workspace `t3-trade-test`,
account `local-hyperliquid-testnet` (the only mission-creation path on
main — phase 8's explicit form is not landed). **Disclosure:** because
R3-1 makes every fresh draft crash, a one-hunk worktree-only patch was
applied to unblock the wake-path test (`TradingAssetPicker.tsx`: plain
`ComboboxTrigger` instead of the Select-based `ComposerSelectControl`;
comment marks it VERIFICATION PATCH; not on any branch, main checkout
untouched). Screenshots: `evidence/final-form/r4-alert-fired.png`,
`r4-alerts-rearmed.png`.

| Acceptance | Result | Evidence |
| --- | --- | --- |
| No mission; price-cross notify alert fires into the feed | Pass | all 23 seeded missions settled/revoked; armed "ETH above 2498.6" at 18:50:33 → fired 18:51:17 "mark ETH crossed above 2498.6 (at 2498.7)" (one evaluator sweep), pushed to the feed via the doorbell; once-watch went `triggered` and left the Armed list |
| Desktop build raises an OS notification | Not testable in web (code-verified) | `apps/desktop/src/ipc/methods/tradingNotification.ts:18-33` raises an Electron `Notification`; `AlertFeedPanel.tsx:214-232` feature-detects `window.desktopBridge?.showTradingNotification` and skips in a web tab — verified the skip silently. No desktop build was launched in this loop |
| Repeat-with-cooldown re-arms | Pass | "HYPE below 48.5, repeats" fired 18:56:50 ("at 41" — testnet HYPE crashed) and **again** 19:01:51, one 5-min cooldown apart, watch back to `active` after each fire |
| Derived-metric alert on a freshly-followed asset refuses honestly | Pass in code; **no user surface exists** | refusal semantics live in the evaluator: `WatchEvaluator.evaluateDerived` treats `archive.derivedMetric`'s `unavailable` as "no fire, no observation write, advance the retry clock" (`WatchEvaluator.ts:1240-1247`); window refusals `derived_needs_archive`/`derived_stale`/`derived_window_unavailable` coded in `archive/derived.ts`. Receipts: `vp test run archive/derived.test.ts WatchEvaluator.test.ts` → 58/58 pass. But the arming form is price-only by design (`AlertFeedPanel.tsx:44`, "the form only arms price watches today") and the chart chip arms price too — on main, a human cannot arm a derived watch at all; that surface is phase 8's analyst |
| Agent wake watches still fire wakes (one Luna-medium mission) | Pass | mission created from the draft's first message (auto-mission log 18:42:03), record carries `provider: codex`, runtime payload `model: gpt-5.6-luna`, options `reasoningEffort: medium`, `serviceTier: default` (the wire value of the UI's checked "Standard" radio — `codexModelOptions.ts:7-14`). Run 1 (1m38s): correct stand-aside EMA analysis, plan published, journal, wake watch armed ("5m close above 2502.02"), reassess booked. The scheduled-reassessment **watch triggered 18:58:44 → harness run 2 woke** (55s): "price closed above 2502, but EMA(9) below EMA(21)… stayed flat; cancelled the stale proxy and armed the next reassessment". Model/effort/tier unchanged across the wake. Sidebar pinned the mission thread with live "Waiting" status |

### Findings

- **[Medium] R4-1 — mission-armed watches don't populate 074's columns.**
  `TradingWatchService.ts:319-325` inserts without `venue`, `asset`,
  `deliver`, `account_id`, `rearm_json`, so mission watches carry empty
  columns while account watches (`TradingAlertService.ts:231-240`) fill
  them. Behavior is safe today — `FollowSetRegistry.ts:159-165` reads
  `watch_json` — but the columns exist precisely so queries don't have to
  parse JSON, and anything that trusts them (my own audits included) misses
  every mission watch.
- **[Info] R4-2 — no UI surface arms derived-metric watches.** The honest
  refusal machinery is present and tested, but on main it is reachable only
  by an agent's `trading_watch` tool. The phase-5 acceptance as written
  ("a derived-metric alert … refuses honestly") is only half-realizable by
  a human; noting as a phase-8 dependency, not a defect.
- **[Info] R4-3 — mixed data sources make watch forensics ambiguous.** The
  mission's `candle_close` watch evaluates on the archiver's bars, which are
  recorded from **mainnet** (see R5-1); the agent's own "closed above 2502"
  journal line reads the same mainnet archive while the mission trades
  testnet marks. For ETH the venues sit within a point so nothing visibly
  broke this round, but a cross can be true on one venue and not the other.
- **[Note] R4-4 — repeat fires while the region holds.** The repeat watch
  re-fired 5:01 after the first fire with HYPE still below the threshold
  (no re-cross needed). Reasonable reading of "repeat with cooldown", recorded
  here because the form's label doesn't say which semantics to expect.

### Verdict

Phase 5 holds up end to end in the live product: arming, firing into the
feed, once-vs-repeat semantics, cooldown re-arm, and — the part the phase
existed to protect — the agent wake path, proven with a real Luna-medium
mission that woke, re-analyzed, and re-armed exactly as designed, with the
mandated model/effort/tier recorded and stable. The gaps are structural
rather than behavioral: no human surface for derived watches (phase 8), a
column-contract inconsistency on mission watches, and the OS-notification
half that only a desktop build can prove.
