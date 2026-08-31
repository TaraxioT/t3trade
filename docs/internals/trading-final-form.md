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
consume the next free ids: 074, 075 — and Phase 8 took 076.

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

### Phase 4 — Watchlist + trading-first home _(landed)_

- [x] Migration 074 part 1: `trading_watchlist` (venue, asset, added_at, position).
- [x] New `apps/web/src/components/trading/`: `TradeHomePanel.tsx`,
      `WatchlistPanel.tsx`, `AccountPositionsPanel.tsx`, `AlertFeedPanel.tsx`,
      `UniverseAssetSearch.tsx`; new `routes/trade.tsx`. The archiver-health
      line (2.4's deferred surface) rides the trade home.
- [x] Mount points: route registration, sidebar entry, "Open trade home"
      palette action, `openOnTradeHome` client setting (default on) redirecting
      the index route. An "Add to watchlist…" palette entry was skipped — it
      needs a palette sub-view, not a one-liner.
- [x] Watchlist rows feed `FollowSetRegistry` directly (the registry reads the
      table); chart-opens ping via the existing chart read path. A missionless
      watchlist asset shows an honest placeholder until Phase 6 entitles it.

After 1 and 3. Shares 074 and `ws.ts` with Phase 5 — one writer.
Notes: per-asset "recording since" awaits a per-asset coverage source; the
watchlist renders in persisted position order (no reorder RPC yet).

### Phase 5 — Alerts become a product

- [x] Migration 074 part 2: `trading_watches` rebuilt (nullable `mission_id`,
      venue/asset, `account_id`, `deliver`, `rearm_json`); new
      `trading_alert_events`. 035's surviving index recreated; backfill
      `deliver='wake'`, `venue='hyperliquid'`; round-trip migration test.
- [x] `WatchEvaluator.ts` subscriptions key off the registry (30s reconcile
      loop); `processFire` branches on `deliver`; pure-notify watches re-arm
      after cooldown; agent wakes stay single-fire; `findActiveMission("local")`
      and the hardcoded market list are dead.
- [x] Account-scoped watch CRUD, arm/cancel/list RPCs, alert-feed read; alert
      appends ring the existing account doorbell rather than a second stream.
- [~] Arming form in `AlertFeedPanel` landed; chart-drag arming waits for
  Phase 6's standalone chart.
- [x] Desktop OS notification via one Electron IPC addition; web feature-detects
      and skips.

After 1, 2.2, 3. **Accept:** a user with no mission arms an alert; it fires into
the feed and as an OS notification; existing wake tests pass unchanged.

### Phase 6 — A real chart _(landed)_

- [x] Candles + EMA overlays with a persisted line/candle toggle; 60-bar floor
      in the geometry; gap and pre-recording shading from archive coverage.
- [x] `volume` restored to `TradingChartCandle` (drawn as a subtle in-chart
      underlay, not a second pane); server-side `maxBars` (default 120, cap
      360); session levels from the archive's 5m bars, live reads only;
      seven-interval timeframe selector — `4h`/`1d` are archive-only so
      `TradingTimeframe`/mandate parsing stay untouched.
- [x] `MarketChartPanel.tsx` for any followed asset; `chartReadEntitlement.ts`
      entitles the follow set; the chart-open ping fires for missionless reads.
      Arm-at-price ships as a hover chip in the price gutter (drag
      generalization would have restructured the mission drag path).

After 1 (drawing) / 2.4 (depth). Upstream: contracts + `ws.ts` only.

### Phase 7 — Guarded manual execution + per-market authority _(landed)_

- [x] Migration 075: the six execution tables rebuilt (nullable `mission_id`,
      `account_id NOT NULL DEFAULT 'unattributed'`, venue/asset);
      `trading_missions` gains `venue`; the one-active-per-user index becomes
      the per-`{venue,asset}` exclusivity index. Round-trip test over
      v074-shaped rows plus the whole chain from empty.
- [x] `TradingManualEntryService.ts` mirroring `TradingEntryService` minus
      harness lease/mandate (stop mandatory at preview);
      `previewManualOrder` in `TradingPreviewService`; `accountPolicy.ts`
      account envelope (testnet-mandate ratios, env-overridable).
- [x] `Cloid.ts` `deriveManualCloid` (mission derivation pinned byte-stable);
      `trading.order.place` command arm + invariants, routed through the
      reactor with a manual owner (`mission_id NULL`, manual idempotency
      namespace); outcomes and refusals land in the alert feed.
- [x] Authority exclusivity both directions with named refusals
      (`market_owned_by_mission` on the ticket,
      `TradingMarketManualExposureError` on mission create); every
      mission-scoped query audited for the nullable `mission_id`; the
      protection/take-profit/working-order watchdogs and the fill-reconciler
      follow loop iterate every active mission, manual positions get their own
      protection guard + 5s manual reconcile pass
      (`reconcileManualExposure`), and the account view carries manual rows
      under the `manual` authority.
- [x] `OrderTicket.tsx` in the trade home with the mandatory stop, the live
      `deriveFeasibleSize` readout, and refusals verbatim; manual reduce/close
      from `AccountPositionsPanel` via `closeTradingManualPosition`.

Notes: `blockedReason 'account_unavailable'` stays out — Phase 7 wrote no
account gate that would set it, and dead enum members are not re-added.
Upstream touches beyond the planned decider/invariants/contracts/`ws.ts`:
one case in `OrchestrationEngine.commandToAggregateRef` (the first threadless
command needs an aggregate ref). The live testnet smoke
(`executionLive.test.ts` pattern) is deliberately left to the operator.

### Phase 8 — The LLM finds its place _(landed)_

- [x] A `trading_analyst` session profile: `trading_look`, `trading_strategy`,
      and `trading_watch` restricted to `deliver:'notify'`; no enter/exit/plan.
      `SessionProfile` carries the second kind as metadata only (endpoint and
      turn-contract frame); the analyst scope is enforced per call from the
      persisted `trading_analyst_threads` registry and the missing mission
      binding. A one-paragraph first-turn prefix in `TradingSessionProfile.ts`
      states the scope as server-enforced fact, and all five adapters deliver
      it through `applyTradingTurnContract`. The
      `trading_watch` handler arms analyst conditions as account-scoped notify
      alerts through `TradingAlertService` (`armed_alert` / `alert_cancelled`
      / `alert_rejected` result arms, additive); `deliver:'wake'` is refused,
      never coerced, and the acting tools refuse on the missing mission
      binding as before.
- [x] "Ask the analyst" on chart and position views; mission creation becomes
      an explicit form dispatching `trading.mission.create`; draft-hero
      claiming retires. One analyst thread per `{venue, asset}`, reused, held
      in `trading_analyst_threads` (migration 076 — the registry is also what
      re-binds analyst profiles after a restart) behind the
      `ensureTradingAnalystThread` RPC: the client mints a candidate thread
      id, the server returns the incumbent or registers the candidate, and the
      client creates the thread and sends the question
      (`useTradingThreadLaunch.ts`). The trade home gains `MissionCreateForm`
      (market via `TradingAssetPicker`, mandate prose, capital, wake budget);
      `ChatView.tsx` lost the draft-hero asset picker and the `tradingMarket`
      ride-along, so a first message can no longer become a mission — the
      env-gated server auto-mission path remains but defaults off (0.3) and is
      Phase 9 deletion fodder.
- [x] `maxWakes` in the authority envelope; exhaustion pauses visibly and
      resumes on click. Rides the versioned authority JSON — no migration.
      Runs are the count and the active authority version's `created_at` is
      the epoch: the coordinator counts `trading_harness_runs` since it, and
      at the cap transitions the mission to `blocked` /
      `wake_budget_exhausted` (new `TradingMissionBlockedReason` member).
      Resume re-issues the same envelope as a fresh authority version
      (`refreshAuthorityVersion`), so the counter resets against the same
      `maxWakes`; the mission strip offers Resume for exactly this blocked
      reason.

After 5, 7, 0.3, 0.4. Upstream touches: the five adapters' trading branches,
`ChatView.tsx` mount-point edits, contracts additively (`ws` command +
payload `maxWakes`, the analyst RPC, the watch-tool `deliver` field and result
arms), `McpSessionRegistry`/`ProviderCommandReactor`'s existing profile checks
widened to both kinds.

### Phase 9 — Deletions and consolidation

- [x] Delete: the `scope[]` read path in `trading_look` (fetch[] is the sole
      survivor; the tests that pinned surviving behavior were re-pinned on
      fetch keys first, and the scope-only behaviors — flat bar cap, `bars`/
      `indicators` inputs, the unbound `lastMission` answer, the retrospect
      full-mandate — died with it); 26 dead contract schemas/aliases in
      `tools.ts`; `submitReduceOnlyAlo`; the unreachable take-profit
      decoration (statuses trimmed to `flat`/`withdrawn`, `placedCloid`/
      `targetPrice` and the ledger INSERT gone, the ignored `target` and
      `executionSequence` inputs gone with `moduleReadPlanTarget`; the
      withdraw-only sweep and the ledger's retirement half stay — Phase 7's
      `guardTakeProfit` reaches exactly those); `missionHeartbeat.ts` and the
      dead presentation exports; the nonce-recovery surface (deleted, not
      wired — the wall-clock fast-forward makes a fresh process's first nonce
      strictly newer than anything signed before it; `HyperliquidNonceError`
      itself stays, `classifyFailure` names its tag);
      `watchSanityBackstopMillis`; the `collapsedMissions` leak (now a
      50-entry bounded Map, same UX); `TradingMarket` remnants (the two bare
      `"ETH"` fallbacks route through `DEFAULT_TRADING_MARKET`;
      `DEFAULT_SEED_COINS` and the picker's offline fallback stay). Also the
      Phase 8 leftovers: the whole auto-mission machinery
      (`TradingAutoMission`, `AutoMissionConfig`, the env gate, the
      `tradingMarket` turn-start field, `POC_STANDING_INSTRUCTION`) — nothing
      but the retired draft-hero path fed it; the assetPicker composer prop
      was already gone.
- [x] Consolidate: `resolveSigner` + `signInNonceLane` in
      `HyperliquidExecutionService` (six pasted blocks each);
      `isTestnetEndpoints` derived from the endpoint URLs (no literals left);
      `RestingIncreasingOrders.ts` (the guard, the emergency close and
      cancel-entries share one read + one best-effort cancel); one
      `readActiveRun` in `TradingRunTelemetry`; the control service's mission
      and manual reduce lanes share one bounded `reduceLoop` — full
      `TradingExitService`/`TradingControlService` unification was declined
      and documented: the exit runs inside a lease-owning turn through the
      record/receipt path, the controls are deliberately preview- and
      lease-free (§14.7), and they already share the reduce-only submit
      primitives; `MissionLivePanel.tsx` (131→37KB, three siblings) and
      `tradingPresentation.ts` (124→29KB, six siblings) split along component
      seams with re-exports keeping every import path.
- [x] Repair the stale doc comments: the phantom `trading_control_*` tool
      names (service header + `docs/architecture/trading-execution.md`); the
      take-profit premises in `TradingWorkingOrderService`,
      `TradingBudgetReader`, `TradingPlanProtectionService` and the
      `TradingPlanTargetReconcileView` contract; the coordinator's
      `ensureNotDeaf` doc still describing the removed covered-gets-backstop
      branch; the `VISIBLE_BARS`/geometry drift (the constant is now the
      imported `MIN_VISIBLE_BARS` the geometry actually floors at).

## 5 · Migration ledger

| Id  | Lands in   | Contents                                                                           | Risk                                                                                                                                                                                                  |
| --- | ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 074 | Phases 4+5 | `trading_watchlist`; `trading_watches` rebuild; `trading_alert_events`             | Recreate 035 indexes; backfill `deliver='wake'`, `venue='hyperliquid'`; wake behavior byte-identical                                                                                                  |
| 075 | Phase 7    | Six execution tables rebuilt; `trading_missions.venue`; per-market authority index | Landed. `account_id` carries `DEFAULT 'unattributed'` (the orphan-backfill sentinel); the position/account-snapshot uniqueness moved onto partial indexes, so upserts name the index `WHERE` clause   |
| 076 | Phase 8    | `trading_analyst_threads` — the per-market analyst-thread registry                 | Landed. Pure `CREATE TABLE IF NOT EXISTS`; also the boot source that re-binds analyst session profiles after a restart                                                                                |
| 085 | Prompt W   | `trading_thesis_validations.last_comparison`; `trading_missions.purpose`           | Landed. Both additive. `last_comparison` is nullable and NOT backfilled, so an existing validation reports no verdict change on its first pass after the upgrade; `purpose` carries `DEFAULT 'trade'` |
| —   | Phase 2    | Archive DB v1→v2 (venue columns) via its own version row                           | Never joins the app chain                                                                                                                                                                             |

## 6 · Deliberately not doing

- No mainnet. The three hard-wired testnet points stay hard-wired.
- No Uniswap work. The venue axis is data-model-deep, not abstraction-deep.
- No shell rewrites. Countable mount points only.
- No mobile in this plan.
- No reactor decomposition.
- No retention machinery yet.

## Forward validation

A thesis (`packages/trading-contracts/src/thesis.ts`) can be backtested over the
archive or validated forward on live bars. The two share their arithmetic
deliberately: `makeThesisSignals` decides what a signal is and `summarizeTrades`
produces the figures, and both `runBacktest` and the forward walk call them. A
forward run is scored against the backtest that armed it, and that comparison is
meaningless if the two engines disagree about which bars fired.

`stepForward` (`packages/trading-contracts/src/forward.ts`) is the batch walk
turned inside out. The backtest's rule — a signal on closed bar `t` fills at bar
`t+1`'s open — cannot be evaluated in one pass when only one bar is visible at a
time, so the delay becomes explicit state carried on the validation row:
`pending_entry_signal_time` and `pending_exit_reason`. Durable, because a fill
owed across a restart is a fill that would otherwise be silently dropped.

The two engines agree exactly on which trades are taken, and to within 0.1% on
the price of an ATR-derived level. That residue is inherent: ATR is a Wilder
average seeded by an SMA, so a trailing window and a full history converge on
slightly different readings. `forward.test.ts` drives 600 bars through both
walks across five theses and asserts the sequence exactly and the price to that
bound.

### Where it runs

`TradingThesisValidationService` owns the lifecycle and the paper ledger. Its
dependency set is the market archive, the SQL client and a UUID source —
`TradingEntryService`, `TradingExitService`, `HyperliquidExecutionService` and
the gateway are deliberately absent, so there is no expression in it that
reaches an order. That absence is the safety claim, and it is asserted from both
sides in `TradingThesisValidationService.test.ts`: a firing thesis leaves every
execution table empty, and settled paper money reaches no real PnL surface.

Evaluation rides `WatchEvaluator.evaluateDelivery`. The candle delivery is the
clock and the archive is the data — the rule the derived watches already follow,
because the archiver trails the websocket by up to a minute. Each pass walks
every archived bar newer than `last_bar_time`, so a lagging archiver is one
delivery late rather than never, and a restart catches up instead of leaving a
hole. It costs no venue read, so the sweep's batched exchange reads are
untouched.

Expiry rides the sweep instead, because a quiet market delivers no candle and a
validation whose window has closed must end anyway. The final report is
delivered as an alert.

An armed or paused validation joins the follow set (`FollowSetRegistry`). This
is load-bearing: an unfollowed market gets no deep recording and no candle
subscription, so without it a validation would look armed and be deaf.

### Tables

Migration 083 adds `trading_thesis_validations` and
`trading_thesis_paper_fills`. Their separation from `trading_fills`,
`trading_closed_trades`, `trading_orders` and `trading_position_snapshots` is
the design rather than a filing decision — a paper fill that reached those would
surface as realised PnL on an account that never traded. A paper fill row with a
null `exit_time` is the open position; there is at most one per validation, and
it is the same row from entry to settlement.

Costs are frozen at arm time. The comparison is against a backtest priced once,
and a fee assumption drifting underneath the run would report a change in the
thesis that was really a change in the spread.

### The live narrative

Evaluation used to be silent. Paper fills landed in `trading_thesis_paper_fills`
and no agent could see them, so an idea could be confirmed or killed over a
fortnight with nothing said about it until the expiry alert.

`advance` now collects what it did — `paper_entry`, `paper_exit`,
`verdict_change`, `expiry` — and `onClosedBar`/`expireDue` return one
`ValidationEventBatch` per validation per pass. Coalescing is structural rather
than a consumer's discipline: a catch-up pass that opens and closes three trades
produces one record, because after it the ledger holds three settled rows and no
account of which pass they belong to.

`verdict_change` needs a previous reading, which is `last_comparison` (migration
085). Nullable, and deliberately not backfilled: a validation armed before the
migration has no previous reading and must not report a change on its first pass
after the upgrade.

`WatchEvaluator.deliverValidationEvents` resolves each batch to a mission — the
validation's own thread first, then the thread its hypothesis was filed in — and
enqueues at most **one inbox event and one `requestRun` per mission per pass**,
with cause `validation_event`. Past six such wakes in an hour the lines are
folded into a count and the wake says it is a summary. A batch that resolves to
no live mission falls back to the alert feed, which is where a validation armed
from the trade home has always reported.

The wake reaches the coordinator directly rather than through
`trading.mission.watch-fired`: that command exists because a fired watch is a
domain event the projection draws, and a paper fill on money nobody has is not.
The composer lifts the lines back out of `pendingEvents` by their
`validation:` dedupe prefix and renders them as `validationEvents`, unclamped,
on both render rungs — a validation wake whose events were trimmed away is a
turn woken to narrate and told nothing to narrate.

The same inbox rows are the timeline source: `buildMissionTimeline` reads them
as `kind: "validation_event"` with the composed summary as the label, so the
agent log row, the chart tick's tooltip and the wake text are one sentence
rather than three descriptions of one paper fill.

### Observe missions

A mission whose `purpose` is `observe` (migration 085, a column rather than a
`control_json` field because purpose is fixed at creation and `control` is the
mutable half). Created through `trading_hypothesis` action `observe`, which
calls `createObserveMission`.

It **takes no market**. `createMission` skips the D4 exclusivity check, the
manual-exposure check and the `trading_mission_markets` insert for it, because
exclusivity exists to stop two agents reaching one netted position and a mission
that cannot place an order is not a second agent on anything. Watching ETH must
not lock ETH out of being traded.

"Cannot trade" is enforced server-side, from persisted state. The mission row's
`purpose` column is the fence: `refuseIfObserving` refuses `trading_plan`,
`trading_enter` and `trading_exit` with reason `mission_cannot_trade` whatever
process the call lands in. (The in-process session profile that used to shape a
per-kind tool allowlist retired with the trading persona: a session is a native
agent plus the trading MCP endpoint, and scope is enforced per call.) The
analyst boundary is the same shape — the persisted `trading_analyst_threads`
registry routes watches to alerts and refuses plan-document writes — asserted
by tests.

Its wakes are `validation_event` plus whatever `time` condition it armed for
itself. `ensureNotDeaf` returns early for it: the staleness floor protects a
position and a plan, and an observer has neither, so the floor would be a
metronome. Its lifecycle — pause, resume, stand-down, boot survival — is the
ordinary one; the boot sweep keys on a deleted thread, and an observe mission
binds a real one.

There is no conversion between the two purposes and none is planned. A trade
mission on a validated market already receives `validation_event` wakes through
the delivery above.

### Promotion

There is no promotion code path, and that is the point. A validated thesis
becomes a position the way any idea does: the user says so and the agent
publishes a plan and enters, with the validation record as context. The tool
description and the menu are tested for this — both must say no order is ever
placed, both must point at the ordinary flow, and neither may contain "auto",
"promote", "automatically" or "go live".
