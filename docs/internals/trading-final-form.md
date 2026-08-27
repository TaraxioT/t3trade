# T3 Trade — final form

The settled product constitution and the execution plan that builds it. This is
the only live trading plan in the repo; every earlier plan artifact was deleted
when this landed. The ground-up audit that produced the evidence lives in the
git history and in the published report artifact, not here.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` landed.

## 1 · Constitution

T3 Trade is a **trading-first, multi-venue, local-first trading workspace**. The
app opens onto watchlist + positions + alert feed + chart. The trader is the
primary actor: guarded manual execution where every entry carries a stop, alerts
with real notifications, and trade review backed by durable market memory. The
LLM is an on-demand analyst, drafter and reviewer — and a delegate only inside an
explicit, wake-budgeted mission. Coding-agent threads remain a secondary mode.

Hyperliquid testnet is venue #1, indefinitely. The data model is venue-plural
from birth; no venue-abstraction machinery is built until a second venue exists.

The fork is **not independent**. Backend, orchestration and harness code remain
upstream-dependent and syncs continue. The trading shell is new fork-owned files
mounted through the existing shell's extension points. Upstream components are
never rewritten.

| Question               | Decision                                                   |
| ---------------------- | ---------------------------------------------------------- |
| Identity / home screen | Trading-first; coding mode secondary                       |
| Asset recording        | Attention-driven follow set + honest coverage display      |
| Market identity        | `{venue, asset}` everywhere                                |
| Mission authority      | Per-market exclusivity: one authority per `{venue, asset}` |
| Protection doctrine    | Provenance-labeled: resting-on-exchange vs server-executed |
| Mainnet                | Testnet indefinitely; a separate future decision           |
| Uniswap                | Direction only — excluded from execution planning          |
| Mobile                 | Post-launch; alert notifications first                     |
| Upstream               | Dependent; additive shell; syncs continue                  |

## 2 · Architecture decisions

- **D1 — Market identity.** `MarketRef = {venue, asset}`; two columns in every
  table that stores a bare market string. One schema in
  `packages/trading-contracts/src/primitives.ts` replaces the `TradingMarket`
  literal union. Asset ids are venue-native and opaque to shared code.
  Validation is dynamic — Hyperliquid's `MarketResolver` is the validator. No
  `VenueAdapter` interface yet. Legacy rows migrate as `venue='hyperliquid'`.
- **D2 — The follow set.** A server-side registry of followed `MarketRef`s
  derived from open positions ∪ armed watches ∪ watchlist ∪ recently-opened
  charts (decay window; cap default ~20). Following starts WS candle collection,
  book sampling and deep recording; first follow triggers a one-time backfill.
  The watch evaluator's hardcoded subscriptions key off the same registry.
  Coverage is honest: per-asset "recording since…", gaps shaded on charts.
- **D3 — Archiver v2.** WS-first candle collection for followed assets
  (`candleSnapshot` retained for boot backfill and gap repair). The single
  `metaAndAssetCtxs` call stores the whole universe — followed at 1m, unfollowed
  sampled at 5m. `l2Book` summaries stay followed-only. Archive DB gains `venue`
  via its **own** version chain; it never joins the app migration chain.
- **D4 — Per-market authority exclusivity.** The global one-active-mission
  invariant becomes: at most one authority per `{venue, asset}`. Missions on
  different markets coexist with manual trading elsewhere. Watchdog, follow loop
  and `confirmedProtectedSize` become per-position/per-market.
- **D5 — Protection provenance.** Every protective order carries
  `resting_on_exchange` vs `server_executed` in the read model, labeled in UI.
- **D6 — Additive shell.** The trading home is a new route module + new panel
  components mounted through existing extension points. Upstream shell files get
  mount-point edits only.

## 3 · Sync posture

Server orchestration, providers, checkpointing and the client shells stay
upstream-owned and sync-eligible. Everything trading lives in fork-owned modules
(`apps/server/src/trading/`, `packages/trading-contracts`, `packages/hyperliquid`,
`apps/web/src/components/trading/`, new route files). Each phase names its
upstream touch points so sync-conflict surface stays measured. Fork migrations
consume the next free ids: 074, 075.

## 4 · Execution plan

Conventions: smallest-proof verification, receipts and worker drains instead of
sleeps, `test-t3-app` for user-visible changes, no repo-wide checks, one writer
per file per batch.

### Phase 0 — Stop the bleeding

- [x] 0.1 Archive staleness guards. `archive/derived.ts`,
      `TradingMarketArchive.ts` + tests. `requireBars` gains a recency bound (last
      stored open older than ~3× interval → unavailable, reason `derived_stale`);
      `scan`'s mark gets a 2-bar freshness bound. **Accept:** with a stopped
      archiver all six lookback metrics refuse rather than serve stale values.
- [x] 0.2 Mission integrity. `TradingMissionService.ts`,
      `TradingMissionSweep.ts`, `TradingMissionReactor.ts`. Boot sweep revokes
      orphans, never deletes; `deleteMission` covers the 8 missing tables;
      `thread.deleted` uses the close-then-revoke path. **Accept:** a projection
      reset leaves mission history intact; deleting a thread with an open position
      closes it and frees the market.
- [x] 0.3 Explicit arming + key hygiene. `AutoMissionConfig.ts`,
      `TradingAutoMission.ts`, the `ws.ts` gate, `InterimSignerConfig.ts`.
      Auto-mission defaults off; the signer key refuses group/other-readable file
      permissions. **Accept:** an armed server creates no mission on a new thread's
      first message.
- [x] 0.4 Wire `agent_unavailable`. `TradingTurnCoordinator.ts`,
      `TradingMissionService.ts`. Repeated failed wakes suspend the mission; the two
      never-written `blockedReason`s are wired or removed. **Accept:** killing the
      provider surfaces `agent_unavailable` within ~1 minute.

Upstream touches: none in the end — 0.3's gate is entirely inside
`AutoMissionConfig`, so `ws.ts` was left alone.

Two decisions made during execution: the boot sweep **revokes** orphans rather
than deleting them, and reads orphanhood off a `thread.deleted` event in the log
rather than off `projection_threads`; and the blocked-reason union lost
`account_unavailable` and `reconciliation_failure`, which nothing wrote —
Phase 7 re-adds the first when the account gate lands.

### Phase 1 — Market identity groundwork _(landed)_

- [x] `MarketRef` schema in `primitives.ts`; `TradingMarket` literals deleted; a
      compat codec mapping legacy `"BTC"|"ETH"` to `{venue:"hyperliquid", asset}`
      for persisted JSON (wakes, plans, watches).
- [x] Mechanical sweep of `TradingMarket` consumers across
      `packages/trading-contracts`, `apps/server/src/trading`,
      `packages/contracts/src/trading.ts` and the web imports. SQL keeps the legacy
      single column until 074/075; the service layer owns the mapping meanwhile.
- [x] `getTradingUniverse` WS RPC backed by `metaAndAssetCtxs`;
      `TradingAssetPicker.tsx` becomes a search over it.

Blocks phases 3, 5, 6, 7. Migrations: none by design.
Upstream touches: `packages/contracts/src/trading.ts`, `orchestration.ts`, `ws.ts`.

### Phase 2 — Archiver v2

- [x] 2.1 Supervision and packaging. Pack `src/trading/archive/main.ts`; new
      `ArchiveSupervisor.ts` spawning the archiver as a Node child (PID captured at
      spawn, exponential backoff, stdout heartbeat); single-writer heartbeat lock.
- [x] 2.2 `FollowSetRegistry.ts` deriving followed markets; emits follow/unfollow
      to the archiver (control channel). The watch-evaluator rewire is Phase 5's.
- [x] 2.3 Collection changes: archive schema v2 with `venue` columns (own
      version chain, a v1 file rebuilt in place), `ARCHIVE_COINS` retired for
      the follow set (BTC/ETH seed only on cold start), WS candle subscriptions
      with per-series poll fallback, the 3m interval, whole-universe
      `asset_ctx`, first-follow lazy hydration.
- [~] 2.4 Archive-backed windowed chart reads landed; archiver health rides
  `TradingMissionSnapshot.archive`. The UI surface lands with Phase 4's
  trade home.

Requires 0.1. Migrations: archive DB own chain only.

### Phase 3 — Account read model + push _(landed)_

- [x] `TradingAccountView` in contracts: venue-keyed accounts, positions
      carrying `MarketRef` + provenance + owning authority, open orders, balance,
      archiver health; plus a data-free invalidation stream
      (`subscribeTradingAccount` — the view RPC is the snapshot, the stream is
      the doorbell).
- [x] `TradingAccountProjection.ts` registered in `ProjectionPipeline.ts`; the
      trading event types invalidate there, and the reconciler rings the same
      bus after every successful pass (that is what makes a fill land in ~1s).
      Derived-on-read, no new table.
- [x] `ws.ts` read handler; client-runtime atoms; `tradingMissionsState.ts`
      consumes push. The 3s poll is retired; a 30s fallback poll remains as a
      backstop for older servers without the subscription RPC.

After Phase 1. **Accept:** a fill updates positions within ~1s with no polling.
Notes: `withdrawableUsd` is `null` — nothing persists it today, and a null is
honest; the `manual` authority arm is reserved for Phase 7.

### Phase 4 — Watchlist + trading-first home

- [ ] Migration 074 part 1: `trading_watchlist` (venue, asset, added_at, position).
- [ ] New `apps/web/src/components/trading/`: `TradeHomePanel.tsx`,
      `WatchlistPanel.tsx`, `AccountPositionsPanel.tsx`, `AlertFeedPanel.tsx`; new
      `routes/trade.tsx` following the `routes/settings.trading.tsx` pattern.
- [ ] Four mount points: route registration, sidebar entry, command palette
      entries, a default-view setting opening on the trade home.
- [ ] Watchlist rows and chart-opens feed `FollowSetRegistry`.

After 1 and 3. Shares 074 and `ws.ts` with Phase 5 — one writer.

### Phase 5 — Alerts become a product

- [ ] Migration 074 part 2: `trading_watches` rebuilt (nullable `mission_id`,
      venue/asset, `account_id`, `deliver`, `rearm_json`); new
      `trading_alert_events`. Recreate 035's dedupe + status indexes; backfill
      `deliver='wake'`, `venue='hyperliquid'`.
- [ ] `WatchEvaluator.ts` subscriptions key off the registry; `processFire`
      branches on `deliver`; repeat semantics for notify watches; agent wakes stay
      single-fire; the hardcoded `findActiveMission("local")` dies.
- [ ] Account-scoped watch CRUD, arm/cancel/list RPCs, alert-feed read + push.
- [ ] Arming form in `AlertFeedPanel`; chart-drag arming (with Phase 6).
- [ ] Desktop OS notification via one Electron IPC addition.

After 1, 2.2, 3. **Accept:** a user with no mission arms an alert; it fires into
the feed and as an OS notification; existing wake tests pass unchanged.

### Phase 6 — A real chart

- [ ] Draw `ChartBar` candles and `buildEmaLine` EMAs (line/candle toggle);
      60–120 bar window; gap shading from archive coverage.
- [ ] Restore `volume` to `TradingChartCandle`; bar-count parameter;
      archive-backed depth; session levels (prior-day H/L/C, today O/H/L, VWAP);
      timeframe selector.
- [ ] `MarketChartPanel.tsx` for any watchlist asset — no mission required;
      `chartReadEntitlement.ts` entitles followed assets. No repainting animation.

After 1 (drawing) / 2.4 (depth). Upstream: contracts + `ws.ts` only.

### Phase 7 — Guarded manual execution + per-market authority

- [ ] Migration 075: the six execution tables rebuilt (nullable `mission_id`,
      `account_id NOT NULL`, venue/asset); `trading_missions` gains `venue`; the
      one-active-per-user index becomes a per-`{venue,asset}` exclusivity index.
- [ ] `TradingManualEntryService.ts` mirroring `TradingEntryService` minus
      harness lease/mandate; preview context variant; `accountPolicy.ts` risk
      envelope.
- [ ] `Cloid.ts` owner-id variant (mission cloids byte-stable);
      `trading.order.place` command arm + invariants routed through the reactor.
- [ ] Authority exclusivity both directions with named refusals; audit every
      `WHERE mission_id = ?` for NULL handling; watchdog iterates account positions.
- [ ] `OrderTicket.tsx` in the trade home with mandatory stop and live
      `deriveFeasibleSize` readout.

After 1 and 3; 075 after 074 is merged. Heaviest migration — round-trip test
against a `VACUUM INTO` snapshot of real data.

### Phase 8 — The LLM finds its place

- [ ] A `trading_analyst` session profile: `trading_look`, `trading_strategy`,
      and `trading_watch` restricted to `deliver:'notify'`; no enter/exit/plan.
- [ ] "Ask the analyst" on chart and position views; mission creation becomes an
      explicit form dispatching `trading.mission.create`; draft-hero claiming retires.
- [ ] `maxWakes` in the authority envelope; exhaustion pauses visibly and
      resumes on click. Rides the versioned authority JSON — no migration.

After 5, 7, 0.3, 0.4.

### Phase 9 — Deletions and consolidation

- [ ] Delete: the `scope[]` read path in `trading_look`; the ~13 dead contract
      schemas in `tools.ts`; `submitReduceOnlyAlo`; the unreachable take-profit
      decoration; `missionHeartbeat.ts` and dead presentation exports; the
      unreachable nonce-recovery surface; `watchSanityBackstopMillis`; the
      `collapsedMissions` module-level leak; surviving `TradingMarket` remnants.
- [ ] Consolidate: the 5× signer-resolution and nonce-lane blocks; `isTestnet`
      derived from endpoints; one cancel-increasing-orders helper; one
      `readActiveRun`; one exit implementation shared by `TradingExitService` and
      `TradingControlService`; split `MissionLivePanel.tsx` and
      `tradingPresentation.ts` along existing seams.
- [ ] Repair the six stale doc comments the audit catalogued.

## 5 · Migration ledger

| Id  | Lands in   | Contents                                                                           | Risk                                                                                                 |
| --- | ---------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 074 | Phases 4+5 | `trading_watchlist`; `trading_watches` rebuild; `trading_alert_events`             | Recreate 035 indexes; backfill `deliver='wake'`, `venue='hyperliquid'`; wake behavior byte-identical |
| 075 | Phase 7    | Six execution tables rebuilt; `trading_missions.venue`; per-market authority index | Heaviest rebuild; audit every `WHERE mission_id = ?`; round-trip test on a real snapshot             |
| —   | Phase 2    | Archive DB v1→v2 (venue columns) via its own version row                           | Never joins the app chain                                                                            |

## 6 · Deliberately not doing

- No mainnet. The three hard-wired testnet points stay hard-wired.
- No Uniswap work. The venue axis is data-model-deep, not abstraction-deep.
- No shell rewrites. Countable mount points only.
- No mobile in this plan.
- No reactor decomposition.
- No retention machinery yet.
