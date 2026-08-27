/**
 * Trading orchestration contracts.
 *
 * The trading extension raises its commands and events on T3's existing
 * orchestration engine rather than a second one, so these follow the
 * `orchestration.ts` member shape exactly: a `type` literal, a `commandId`, the
 * `threadId` the mission's harness is bound to, and an ISO `createdAt`.
 *
 * Timestamps here are ISO strings because this is the upstream read-model
 * boundary. The trading tables store INTEGER epoch millis (migration 035), and
 * the trading projector converts between the two. The one deliberate exception
 * is the embedded `TradingPlanState` and `PersistedWatch` payloads: those
 * are published spec contracts carried verbatim, millis and all, so the shape
 * the harness published is the shape the UI reads.
 *
 * @module TradingOrchestration
 */
import {
  MarketRef,
  MarketWatch,
  TradingMarket,
  TradingVenue,
  TradingPlanState,
  PublishTradingPlanBody,
  PublishTradingPlanRejection,
  PersistedWatch,
  PersistedWatchStatus,
  TradingAuthority,
  TradingHarnessBinding,
  TradingHarnessRunCause,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
  TradingOrderIntent,
  TradingOrderSide,
  TradingOrderTimeInForce,
  TradingUniverseEntry,
  TradingUrgency,
  TradingWatchDeliver,
  TradingWatchRearm,
  WatchCondition,
} from "@t3tools/trading-contracts";
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const TradingMissionId = Schema.String.pipe(Schema.brand("TradingMissionId"));
export type TradingMissionId = typeof TradingMissionId.Type;

// Re-exported so orchestration.ts can type the composer's per-thread market
// choice without importing the trading spec package directly.
export { TradingMarket };

// -- execution read-model views (PROMPT-04 Step 10) --------------------------

/**
 * The order-intent card: a single in-flight execution record the UI shows while
 * an order is being signed/submitted/inspected. Null once the execution settles.
 */
export const TradingExecutionView = Schema.Struct({
  executionId: Schema.String,
  cloid: Schema.String,
  actionType: Schema.String,
  side: Schema.Literals(["buy", "sell"]),
  market: Schema.String,
  size: Schema.Number,
  limitPrice: Schema.Number,
  timeInForce: TradingOrderTimeInForce,
  reduceOnly: Schema.Boolean,
  status: Schema.String,
  updatedAt: IsoDateTime,
});
export type TradingExecutionView = typeof TradingExecutionView.Type;

/**
 * One order across its whole lifecycle, for the positions ledger — plan 39
 * phase 0. `TradingExecutionView` carries only the single in-flight record;
 * this view carries every order the mission has placed, joined to its fill
 * aggregate, so the UI can draw queued / working / partial / filled /
 * cancelled / rejected rows from one array.
 *
 * Status vocabulary, verbatim from the execution records:
 * `reserved → submitted → accepted → filled | cancelled | rejected`.
 */
export const TradingOrderView = Schema.Struct({
  executionId: Schema.String,
  cloid: Schema.String,
  actionType: Schema.String,
  side: Schema.Literals(["buy", "sell"]),
  market: Schema.String,
  size: Schema.Number,
  limitPrice: Schema.Number,
  timeInForce: TradingOrderTimeInForce,
  reduceOnly: Schema.Boolean,
  status: Schema.String,
  /** How much of `size` has filled so far, summed across partial fills. */
  filledSize: Schema.Number,
  /** Size-weighted average fill price; null until the first fill lands. */
  avgFillPrice: Schema.NullOr(Schema.Number),
  /** Fees paid across this order's fills so far. */
  feeUsd: Schema.Number,
  /** Realised PnL the exchange attributed to this order's fills. */
  closedPnl: Schema.Number,
  /** Exchange order id, from the reconciled open-order table or fills. */
  orderId: Schema.optional(Schema.Number),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TradingOrderView = typeof TradingOrderView.Type;

/**
 * A fill receipt: one reconciled fill the UI shows per execution (timestamp,
 * order id/cloid, average fill, fees).
 */
export const TradingFillView = Schema.Struct({
  cloid: Schema.optional(Schema.String),
  orderId: Schema.Number,
  market: Schema.String,
  side: Schema.Literals(["buy", "sell"]),
  filledSize: Schema.Number,
  avgFillPrice: Schema.Number,
  feeUsd: Schema.Number,
  /** Realised PnL the exchange attributed to this fill (§16.2 closedPnl). */
  closedPnl: Schema.Number,
  /**
   * Where the fill sat in the position's life, as the exchange labelled it:
   * "Open Long", "Close Long", "Open Short", "Close Short", or a reversal like
   * "Long > Short". Absent on fills recorded before this was carried.
   *
   * The receipt needs it because `side` alone does not say what happened — a
   * sell opens a short and closes a long — and the position snapshot carries
   * only the current exposure, so the UI cannot recover it by walking back.
   */
  direction: Schema.optional(Schema.String),
  tradedAt: IsoDateTime,
});
export type TradingFillView = typeof TradingFillView.Type;

/**
 * The live position card: entry, mark (unrealised PnL), size, stop
 * (protectedSize), from reconciled projections. Null when flat.
 */
export const TradingPositionView = Schema.Struct({
  market: Schema.String,
  size: Schema.Number,
  entryPrice: Schema.optional(Schema.Number),
  markPrice: Schema.optional(Schema.Number),
  unrealisedPnl: Schema.Number,
  marginUsed: Schema.Number,
  protectedSize: Schema.Number,
  /** Exchange liquidation price, surfaced to the position card. */
  liquidationPrice: Schema.optional(Schema.Number),
  observedAt: IsoDateTime,
});
export type TradingPositionView = typeof TradingPositionView.Type;

/**
 * One OHLCV bar for the chart. Volume rides along (final-form phase 6: the
 * market chart draws a volume underlay); trade count is still dropped —
 * nothing renders it, so carrying it is bandwidth for nothing on a 15s poll.
 */
export const TradingChartCandle = Schema.Struct({
  /** Epoch millis, start of the bar. */
  openTime: Schema.Number,
  open: Schema.Number,
  high: Schema.Number,
  low: Schema.Number,
  close: Schema.Number,
  volume: Schema.Number,
});
export type TradingChartCandle = typeof TradingChartCandle.Type;

/**
 * The UTC-day anchored session levels a market chart rules (final-form phase
 * 6): the prior day's extremes and close, today's open and extremes, and the
 * volume-weighted average price of the current UTC day. Every half is
 * optional — the archive serves what it has recorded and nothing more, and a
 * missing level is simply not drawn.
 */
export const TradingChartSessionLevels = Schema.Struct({
  priorDayHigh: Schema.optional(Schema.Number),
  priorDayLow: Schema.optional(Schema.Number),
  priorDayClose: Schema.optional(Schema.Number),
  todayOpen: Schema.optional(Schema.Number),
  todayHigh: Schema.optional(Schema.Number),
  todayLow: Schema.optional(Schema.Number),
  vwap: Schema.optional(Schema.Number),
});
export type TradingChartSessionLevels = typeof TradingChartSessionLevels.Type;

/**
 * A stretch of the served window the archive knows it is missing, so the
 * client can shade it instead of drawing a line that pretends continuity.
 */
export const TradingChartGap = Schema.Struct({
  /** Epoch millis, inclusive bounds of the missing stretch. */
  fromT: Schema.Number,
  toT: Schema.Number,
});
export type TradingChartGap = typeof TradingChartGap.Type;

/** Candle intervals the chart RPC serves — the archive's own interval set. */
export const TradingChartInterval = Schema.Literals(["1m", "3m", "5m", "15m", "1h", "4h", "1d"]);
export type TradingChartInterval = typeof TradingChartInterval.Type;

/**
 * Candles plus the snapshot figures for one market. The chart needs both a
 * price series and the current mark/funding/OI/volume/change to render its
 * header and footer rows, so they travel together. `null` never appears in
 * this struct: a failed read yields `null` for the whole RPC response (the
 * service never serves a half-populated chart).
 */
export const TradingMarketChartView = Schema.Struct({
  market: TrimmedNonEmptyString,
  interval: TradingChartInterval,
  candles: Schema.Array(TradingChartCandle),
  markPrice: Schema.Number,
  change24hPercent: Schema.Number,
  fundingRate8h: Schema.Number,
  openInterest: Schema.Number,
  dayVolumeUsd: Schema.Number,
  /** When the gateway last confirmed these figures. */
  observedAt: IsoDateTime,
  /**
   * Set when this view is the last good read rather than a fresh one.
   *
   * A single transient exchange failure used to blank the chart and surface as
   * an ERROR-level log, for one poll tick of one market. A chart a few seconds
   * behind, labelled as such, is a better answer than no chart — but only up to
   * a point, so the service stops serving stale past a few minutes and the RPC
   * fails properly from there.
   */
  stale: Schema.optional(Schema.Boolean),
  /**
   * Session levels for the market, from the archive's own 5m record. Absent
   * on windowed (post-mortem) reads — "today" would be the wrong day — and
   * whenever the archive has nothing to compute them from.
   */
  sessionLevels: Schema.optional(TradingChartSessionLevels),
  /**
   * Epoch millis of the oldest bar the archive holds for this market at this
   * interval. The client shades everything before it: recording that started
   * yesterday must not read as a market that started yesterday. Absent when
   * the archive holds nothing for the series.
   */
  recordingSince: Schema.optional(Schema.Number),
  /** Known missing stretches inside the served window, for honest shading. */
  gaps: Schema.optional(Schema.Array(TradingChartGap)),
});
export type TradingMarketChartView = typeof TradingMarketChartView.Type;

/**
 * The completion summary card's figures (§14.7 risk chrome).
 *
 * Aggregated across ALL of the mission's fills, not the capped set the receipt
 * list carries: a summary that only counted recent fills would understate a
 * mission that traded more times than the cap.
 */
export const TradingMissionResultView = Schema.Struct({
  /** Realised PnL the exchange attributed to this mission's fills. */
  realizedPnlUsd: Schema.Number,
  /** Trading fees already paid. Always a cost, never netted into PnL twice. */
  feesPaidUsd: Schema.Number,
  fillCount: NonNegativeInt,
  /** First and last fill, for the mission's traded duration. */
  firstFillAt: Schema.NullOr(IsoDateTime),
  lastFillAt: Schema.NullOr(IsoDateTime),
  /**
   * What the mission actually had at stake: each entry's planned loss at its
   * approved stop, scaled to the part of that entry which really filled — plan
   * 34 step 7.3.
   *
   * The card used to read the PLAN's `maximumPlannedLossUsd`, which a model
   * writes from the authority's per-position ceiling. On a mission whose entry
   * filled an eighth of its request that ceiling was $63 against $1.70 really
   * risked, and "versus plan +$62.81" was arithmetic on a position that never
   * existed. Null when no entry record carries a planned loss — then the plan's
   * own number is all there is.
   */
  plannedLossAtStopUsd: Schema.NullOr(Schema.Number),
});
export type TradingMissionResultView = typeof TradingMissionResultView.Type;

/**
 * One thing that already happened to the mission — plan 24 §4.2.
 *
 * The rest of the read model is current state: the watches armed now, the
 * position held now, the stop resting now. None of it can say that the stop
 * walked up behind a winner in four steps, or that the last five wakes were all
 * the staleness floor rearming itself. Those facts sit in three different domain
 * tables, and this is the one array that spares every client the join.
 *
 * Bounded server-side: history grows without limit and this rides a 3s poll.
 */
export const TradingMissionTimelineEntry = Schema.Struct({
  at: IsoDateTime,
  kind: Schema.Literals(["wake", "stop_adjusted", "strategy_published", "journal"]),
  /** Already-composed prose, so the client renders rather than interprets. */
  label: TrimmedNonEmptyString,
  /** The price the event happened at, where it had one — a stop step's new stop. */
  priceLevel: Schema.optional(Schema.Number),
  /**
   * A wake's run cause, verbatim, for colour-coding by trigger class. Absent on
   * every other kind.
   */
  cause: Schema.optional(TrimmedNonEmptyString),
  /**
   * The tool names the wake's run called, verbatim and in call order — the
   * already-recorded per-run list from `trading_harness_runs.tools_called_json`
   * (migration 051). What the agent read and did during the wake, as the run's
   * own funnel saw it. Absent when the run called nothing or on every other
   * kind; a literal the client translates, like `cause`.
   */
  toolsCalled: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /**
   * Who wrote a journal note (plan 29 step 8.4). Absent on every other kind.
   *
   * The timeline is where the session is read back, so it is where the
   * distinction has to survive: a level the operator dragged and a level the
   * model published are two different accounts of the same session, and drawn
   * identically the timeline says the model decided something it did not.
   */
  author: Schema.optional(Schema.Literals(["user", "model"])),
});
export type TradingMissionTimelineEntry = typeof TradingMissionTimelineEntry.Type;

// -- read model --------------------------------------------------------------

/**
 * A mission as the workspace UI reads it: the mandate, the published strategy,
 * and the watches, in one row so a client never has to join them itself.
 */
export const OrchestrationTradingMission = Schema.Struct({
  id: TradingMissionId,
  threadId: ThreadId,
  userId: TrimmedNonEmptyString,
  tradingAccountId: TrimmedNonEmptyString,
  instruction: TrimmedNonEmptyString,
  market: TrimmedNonEmptyString,

  status: TradingMissionStatus,
  blockedReason: Schema.NullOr(TradingMissionBlockedReason),

  authority: TradingAuthority,
  authorityVersion: NonNegativeInt,
  /**
   * The mission row's optimistic-lock version — what `trading_look` hands the
   * model as `missionVersion`, and what plan 29 step 8.4's drag sends back as
   * `expectedMissionVersion`. Read live, never projected.
   */
  missionVersion: NonNegativeInt,

  strategy: Schema.NullOr(TradingPlanState),

  watches: Schema.Array(PersistedWatch),

  control: TradingMissionControl,
  harness: TradingHarnessBinding,

  // PROMPT-04 execution surfaces. Optional so a mission without execution
  // history still decodes — the UI renders the cards only when present.
  /** The order-intent card while an execution is in flight (§10). */
  inFlightExecution: Schema.NullOr(TradingExecutionView),
  /** Recent fill receipts (§10), newest first. */
  recentFills: Schema.Array(TradingFillView),
  /**
   * Every order the mission has placed, newest first and capped — plan 39
   * phase 0. The positions ledger draws one row per order from this; it is
   * additive beside `inFlightExecution` and `recentFills`, which older
   * surfaces still read.
   */
  orders: Schema.Array(TradingOrderView),
  /** The live position card from reconciled projections (§10). Null when flat. */
  position: Schema.NullOr(TradingPositionView),
  /**
   * The market's live mark price.
   *
   * Read from the exchange rather than from the position, because the position
   * snapshot's mark is cleared the moment the mission goes flat — and a waiting
   * mission is exactly the one whose surfaces need to say where the market is.
   * Absent when the exchange read failed; never a stale carry-forward.
   */
  marketPrice: Schema.optional(Schema.Number),
  /**
   * The leverage the exchange has this mission's market configured at, e.g. 20.
   *
   * Mission-level rather than on the position, because it is a setting and not a
   * measurement: it is the same for the position that just closed and the one
   * about to open, and the receipts that quote it are read after the position
   * they belong to is gone. Absent until the first reconcile has seen one.
   */
  leverage: Schema.optional(Schema.Number),
  /** Realised result across every fill, for the completion summary card. */
  result: TradingMissionResultView,
  /**
   * What has already happened, newest first and bounded — plan 24 §4.2.
   *
   * Empty for a mission that has not woken, published, or moved a stop yet.
   */
  missionTimeline: Schema.Array(TradingMissionTimelineEntry),

  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationTradingMission = typeof OrchestrationTradingMission.Type;

/**
 * Whether the market archiver is running, and how far behind it is.
 *
 * The archive is what every windowed chart, every derived metric, and every
 * "recording since…" label reads from, so its health is not an operations
 * detail — it is the difference between a number and a refusal, and a surface
 * that shows one has to be able to explain the other.
 */
export const TradingArchiveHealth = Schema.Struct({
  running: Schema.Boolean,
  /** The heartbeat line the archiver last printed, verbatim. */
  lastHeartbeat: Schema.NullOr(Schema.String),
  /** When that line arrived. Null means it has not printed one yet. */
  lastHeartbeatAt: Schema.NullOr(IsoDateTime),
  /** Restarts since the server booted. A climbing number is a crash loop. */
  restarts: NonNegativeInt,
  /** Why it is not running, when it is not. */
  stoppedReason: Schema.NullOr(Schema.String),
});
export type TradingArchiveHealth = typeof TradingArchiveHealth.Type;

export const TradingMissionSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  missions: Schema.Array(OrchestrationTradingMission),
  updatedAt: IsoDateTime,
  /**
   * Optional so an older server still decodes. Rides this snapshot rather than
   * getting its own poll: every surface that shows a derived number is already
   * reading it, and archiver health is what says whether that number is real.
   */
  archive: Schema.optional(TradingArchiveHealth),
});
export type TradingMissionSnapshot = typeof TradingMissionSnapshot.Type;

/**
 * The venue's tradable universe, as the asset picker and watchlist search it.
 *
 * Served whole rather than searched server-side: it is a couple of hundred
 * rows off one cached exchange read, and a client that holds it can filter
 * without a round trip per keystroke.
 */
export const TradingUniverseView = Schema.Struct({
  assets: Schema.Array(TradingUniverseEntry),
  observedAt: IsoDateTime,
});
export type TradingUniverseView = typeof TradingUniverseView.Type;

// -- account read model (final-form phase 3) ---------------------------------

/**
 * How a protective order is enforced — the D5 provenance label.
 *
 * `resting_on_exchange`: a trigger order rests on the venue and fires without
 * T3 being up. `server_executed`: the server watches the level and submits the
 * close itself. Everything today is `resting_on_exchange` — Hyperliquid trigger
 * orders rest on the exchange — but the UI has to be able to say which promise
 * it is showing, so the label travels from birth.
 */
export const TradingProtectionProvenance = Schema.Literals([
  "resting_on_exchange",
  "server_executed",
]);
export type TradingProtectionProvenance = typeof TradingProtectionProvenance.Type;

/**
 * Who is allowed to act on a position or order — the D4 owning authority.
 *
 * Today every row in the reconciled tables belongs to a mission, so `mission`
 * is the only kind the server emits; `manual` exists so Phase 7's guarded
 * manual execution is a data change, not a schema change.
 */
export const TradingOwningAuthority = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("mission"),
    missionId: TradingMissionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("manual"),
  }),
]);
export type TradingOwningAuthority = typeof TradingOwningAuthority.Type;

/**
 * One open position as the account view carries it: market identity as a
 * `MarketRef`, the reconciled figures, plus provenance and authority. The
 * per-mission `TradingPositionView` stays for the mission surfaces; this row
 * is the account-addressed reading of the same reconciled snapshot.
 */
export const TradingAccountPosition = Schema.Struct({
  market: MarketRef,
  size: Schema.Number,
  entryPrice: Schema.optional(Schema.Number),
  markPrice: Schema.optional(Schema.Number),
  unrealisedPnl: Schema.Number,
  marginUsed: Schema.Number,
  protectedSize: Schema.Number,
  /** Null when nothing protects the position (protected size is zero). */
  protection: Schema.NullOr(TradingProtectionProvenance),
  authority: TradingOwningAuthority,
  liquidationPrice: Schema.optional(Schema.Number),
  observedAt: IsoDateTime,
});
export type TradingAccountPosition = typeof TradingAccountPosition.Type;

/** One reconciled open order, addressed by account rather than mission. */
export const TradingAccountOpenOrder = Schema.Struct({
  market: MarketRef,
  cloid: TrimmedNonEmptyString,
  orderId: Schema.Number,
  side: Schema.Literals(["buy", "sell"]),
  limitPrice: Schema.Number,
  remainingSize: Schema.Number,
  reduceOnly: Schema.Boolean,
  authority: TradingOwningAuthority,
  observedAt: IsoDateTime,
});
export type TradingAccountOpenOrder = typeof TradingAccountOpenOrder.Type;

/**
 * One trading account on one venue: its balance as last reconciled, and the
 * positions and open orders that belong to it.
 *
 * `balanceUsd` is null until a reconcile has observed the account;
 * `withdrawableUsd` is null today because no reconciled table persists it —
 * a null is honest where a stale or invented number would not be.
 */
export const TradingAccountState = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  venue: TradingVenue,
  balanceUsd: Schema.NullOr(Schema.Number),
  withdrawableUsd: Schema.NullOr(Schema.Number),
  /** When the balance was last reconciled. Null when it never was. */
  balanceObservedAt: Schema.NullOr(IsoDateTime),
  positions: Schema.Array(TradingAccountPosition),
  openOrders: Schema.Array(TradingAccountOpenOrder),
});
export type TradingAccountState = typeof TradingAccountState.Type;

/**
 * The account read model: trading state addressed by account and market
 * rather than by mission. Derived on read from the reconciled tables — there
 * is no projection table behind it to go stale.
 */
export const TradingAccountView = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  accounts: Schema.Array(TradingAccountState),
  updatedAt: IsoDateTime,
  /** Same rider as on `TradingMissionSnapshot`, for the same reason. */
  archive: Schema.optional(TradingArchiveHealth),
});
export type TradingAccountView = typeof TradingAccountView.Type;

/**
 * The push half of the account read model: the server says "something you
 * derived from the trading tables changed", the client refetches. The event
 * deliberately carries no data — the view is derived on read, so the fetch is
 * the truth and the event is only the doorbell.
 */
export const TradingAccountStreamEvent = Schema.Struct({
  kind: Schema.Literal("invalidated"),
  /** Monotonic per server process, so a client can dedupe replays. */
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
});
export type TradingAccountStreamEvent = typeof TradingAccountStreamEvent.Type;

// -- account-scoped watches + alert feed (final-form phase 5) ----------------

/**
 * Arm an account-scoped watch — no mission anywhere near it. The condition is
 * the same vocabulary the model writes (`WatchCondition`); the server refuses
 * position-scoped kinds (pnl, giveback, fill) and any deliver other than
 * `notify`, because a wake needs a mission thread to wake.
 */
export const TradingArmWatchInput = Schema.Struct({
  condition: WatchCondition,
  /** Defaults to `notify` — the only route an account watch may take today. */
  deliver: Schema.optional(TradingWatchDeliver),
  /** Once (the default) or repeat-with-cooldown. */
  rearm: Schema.optional(TradingWatchRearm),
  accountId: Schema.optional(TrimmedNonEmptyString),
});
export type TradingArmWatchInput = typeof TradingArmWatchInput.Type;

/** One account-scoped watch as the RPCs serve it. */
export const TradingAccountWatch = Schema.Struct({
  id: TrimmedNonEmptyString,
  market: MarketRef,
  condition: WatchCondition,
  deliver: TradingWatchDeliver,
  rearm: Schema.optional(TradingWatchRearm),
  status: PersistedWatchStatus,
  accountId: Schema.NullOr(Schema.String),
  /** What the predicate last read, when the evaluator could read a value. */
  lastObservedValue: Schema.optional(Schema.Number),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TradingAccountWatch = typeof TradingAccountWatch.Type;

/** Refusals are answers, not errors: the reason is for the user to read. */
export const TradingArmWatchResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("armed"), watch: TradingAccountWatch }),
  Schema.Struct({ outcome: Schema.Literal("rejected"), reason: TrimmedNonEmptyString }),
]);
export type TradingArmWatchResult = typeof TradingArmWatchResult.Type;

export const TradingCancelWatchInput = Schema.Struct({
  watchId: TrimmedNonEmptyString,
});
export type TradingCancelWatchInput = typeof TradingCancelWatchInput.Type;

/** False when nothing active matched — already fired, cancelled, or unknown. */
export const TradingCancelWatchResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type TradingCancelWatchResult = typeof TradingCancelWatchResult.Type;

export const TradingWatchListView = Schema.Struct({
  watches: Schema.Array(TradingAccountWatch),
});
export type TradingWatchListView = typeof TradingWatchListView.Type;

/** One fired alert in the feed. Append-only history; newest first. */
export const TradingAlertEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  market: MarketRef,
  accountId: Schema.NullOr(Schema.String),
  watchId: TrimmedNonEmptyString,
  firedAt: IsoDateTime,
  summary: Schema.String,
});
export type TradingAlertEvent = typeof TradingAlertEvent.Type;

export const TradingListAlertsInput = Schema.Struct({
  /** Clamped server-side to [1, 200]; default 50. */
  limit: Schema.optional(NonNegativeInt),
});
export type TradingListAlertsInput = typeof TradingListAlertsInput.Type;

export const TradingAlertFeedView = Schema.Struct({
  alerts: Schema.Array(TradingAlertEvent),
});
export type TradingAlertFeedView = typeof TradingAlertFeedView.Type;

// -- the watchlist (final-form phase 4) --------------------------------------

export const TradingWatchlistEntry = Schema.Struct({
  market: MarketRef,
  addedAt: IsoDateTime,
  position: NonNegativeInt,
});
export type TradingWatchlistEntry = typeof TradingWatchlistEntry.Type;

export const TradingWatchlistView = Schema.Struct({
  entries: Schema.Array(TradingWatchlistEntry),
});
export type TradingWatchlistView = typeof TradingWatchlistView.Type;

export const TradingWatchlistMutationInput = Schema.Struct({
  market: MarketRef,
});
export type TradingWatchlistMutationInput = typeof TradingWatchlistMutationInput.Type;

/** A rejected add names its reason (unknown asset, delisted market). */
export const TradingWatchlistMutationResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("ok"), entries: Schema.Array(TradingWatchlistEntry) }),
  Schema.Struct({ outcome: Schema.Literal("rejected"), reason: TrimmedNonEmptyString }),
]);
export type TradingWatchlistMutationResult = typeof TradingWatchlistMutationResult.Type;

// -- client-dispatchable commands -------------------------------------------

export const TradingMissionCreateCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.create"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  tradingAccountId: TrimmedNonEmptyString,
  instruction: TrimmedNonEmptyString,
  /** Omit to have the server resolve the mandate from the live account value. */
  allocatedCapitalUsd: Schema.optional(Schema.Number),
  /** The market the mission is mandated to trade. Omit for the default (ETH). */
  market: Schema.optional(TradingMarket),
  createdAt: IsoDateTime,
});

/**
 * The §14.7 controls that are pure §11.1 status transitions.
 *
 * Pause, resume, and revoke change what the mission is allowed to do next and
 * touch no exchange state, so they resolve to a target status in the decider.
 * The four controls that DO touch live exchange state are separate — see
 * `TradingMissionRiskControlCommand`.
 */
export const TradingMissionControlCommand = Schema.Struct({
  type: Schema.Literals([
    "trading.mission.pause",
    "trading.mission.resume",
    "trading.mission.revoke",
  ]),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  createdAt: IsoDateTime,
});

/**
 * The §14.7 controls that reach the exchange.
 *
 * Modelled apart from the lifecycle controls because they are not status
 * transitions: each one submits signed actions and only then reports what the
 * mission became. Their defining property (§14.7) is that a workspace button
 * invokes them directly — no harness turn, and availability that does not
 * depend on the bound harness being online.
 */
export const TradingRiskControl = Schema.Literals([
  "cancel_entries",
  "reduce_position",
  "close_position",
  "close_and_revoke",
]);
export type TradingRiskControl = typeof TradingRiskControl.Type;

/** The four reduction sizes the workspace offers (§14.7). */
export const TradingReductionPercent = Schema.Literals([25, 50, 75, 100]);
export type TradingReductionPercent = typeof TradingReductionPercent.Type;

export const TradingMissionRiskControlCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.risk-control"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  control: TradingRiskControl,
  /** Required by `reduce_position`, meaningless for the others. */
  reductionPercent: Schema.optional(TradingReductionPercent),
  createdAt: IsoDateTime,
});

/**
 * Final-form Phase 7: the user places a MANUAL order from the trade home's
 * ticket.
 *
 * The one trading command with no `threadId` and no mission — a manual order
 * belongs to the trading account. The decider validates the shape invariants
 * (a positive stop, exactly one size expression) and raises the request event;
 * `TradingMissionReactor` runs the manual write side — prepare, the manual
 * checklist, submit under the manual cloid namespace — and a refusal lands in
 * the alert feed with the server's own reason.
 */
export const TradingOrderPlaceCommand = Schema.Struct({
  type: Schema.Literal("trading.order.place"),
  commandId: CommandId,
  /** Omit for the local testnet account. */
  accountId: Schema.optional(TrimmedNonEmptyString),
  market: TradingMarket,
  side: TradingOrderSide,
  /** Mandatory: a manual entry without a stop is refused, never defaulted. */
  stopPrice: Schema.Number,
  /** Size in base units, or the same request in USD of notional — one of them. */
  sizeEth: Schema.optional(Schema.Number),
  notionalUsd: Schema.optional(Schema.Number),
  /** Mirrors the agent's entry: `now` crosses, `patient` rests post-only. */
  urgency: Schema.optional(TradingUrgency),
  createdAt: IsoDateTime,
});
export type TradingOrderPlaceCommand = typeof TradingOrderPlaceCommand.Type;

export const DispatchableTradingCommand = Schema.Union([
  TradingMissionCreateCommand,
  TradingMissionControlCommand,
  TradingMissionRiskControlCommand,
  TradingOrderPlaceCommand,
]);
export type DispatchableTradingCommand = typeof DispatchableTradingCommand.Type;

// -- the manual order ticket (final-form Phase 7) ----------------------------

/**
 * What the ticket asks the server to price and pre-check. Identical fields to
 * `TradingOrderPlaceCommand` minus the command envelope — preview is an RPC so
 * the refusal reason lands on screen, place is a command so the write is
 * event-sourced.
 */
export const TradingOrderPreviewInput = Schema.Struct({
  /** Omit for the local testnet account. */
  accountId: Schema.optional(TrimmedNonEmptyString),
  market: TradingMarket,
  side: TradingOrderSide,
  stopPrice: Schema.Number,
  sizeEth: Schema.optional(Schema.Number),
  notionalUsd: Schema.optional(Schema.Number),
  urgency: Schema.optional(TradingUrgency),
});
export type TradingOrderPreviewInput = typeof TradingOrderPreviewInput.Type;

/**
 * The server's answer, verbatim: either the priced, sized, pre-checked ticket,
 * or the refusal in the server's own words. `feasibleSize` is the live
 * `deriveFeasibleSize` readout — the largest size every account ceiling allows.
 */
export const TradingOrderPreviewResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("prepared"),
    size: Schema.Number,
    feasibleSize: Schema.Number,
    notionalUsd: Schema.Number,
    limitPrice: Schema.Number,
    plannedLossAtStopUsd: Schema.Number,
    estimatedRoundTripCostUsd: Schema.Number,
    constrainedBy: TrimmedNonEmptyString,
    notes: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused"),
    /** The server's rule name (`market_owned_by_mission`, a checklist item…). */
    reason: TrimmedNonEmptyString,
    detail: Schema.String,
    feasibleSize: Schema.optional(Schema.Number),
  }),
]);
export type TradingOrderPreviewResult = typeof TradingOrderPreviewResult.Type;

/**
 * Close or reduce a MANUAL position from the positions panel. Mission-owned
 * positions refuse here — their way out is the mission's §14.7 controls.
 */
export const TradingManualCloseInput = Schema.Struct({
  /** Omit for the local testnet account. */
  accountId: Schema.optional(TrimmedNonEmptyString),
  market: MarketRef,
  /** Omit for a full close. */
  percent: Schema.optional(TradingReductionPercent),
});
export type TradingManualCloseInput = typeof TradingManualCloseInput.Type;

export const TradingManualCloseResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("done"),
    /** Signed canonical position size after the control. */
    positionSize: Schema.Number,
    summary: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused"),
    reason: TrimmedNonEmptyString,
    detail: Schema.String,
  }),
]);
export type TradingManualCloseResult = typeof TradingManualCloseResult.Type;

// -- server-raised commands --------------------------------------------------

/**
 * A transition the server decided: a watch fired, a harness run ended, a
 * deterministic safety condition tripped. §11.1 legality is enforced by
 * `TradingMissionService.transition`, which is the only writer of mission
 * status; this command records the transition it performed.
 */
export const TradingMissionStatusSetCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.status-set"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  status: TradingMissionStatus,
  blockedReason: Schema.optional(TradingMissionBlockedReason),
  createdAt: IsoDateTime,
});

export const TradingMissionStrategyPublishedCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.strategy-published"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  createdAt: IsoDateTime,
});

/**
 * A watch was registered or cancelled - spec §11.3, §12.1.
 *
 * The watch registry is the writer; this command records the outcome so the
 * workspace sees the new watch (or the cancellation) on the ordered WS push
 * path rather than polling.
 */
export const TradingMissionWatchRegisteredCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.watch-registered"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  /** The full persisted watch, as the registry accepted it. */
  watch: PersistedWatch,
  createdAt: IsoDateTime,
});

export const TradingMissionWatchCancelledCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.watch-cancelled"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  watchId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/**
 * A watch predicate matched - spec §11.3, §12.1.
 *
 * Raised by the watch evaluator after it flips a watch to `triggered` and
 * persists the inbox event. The turn coordinator consumes this to decide
 * whether to acquire the lease and wake the bound session.
 */
export const TradingMissionWatchFiredCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.watch-fired"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  watchId: TrimmedNonEmptyString,
  /** The deduplication key the inbox event was persisted under. */
  deduplicationKey: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/**
 * A harness run started - spec §11.2, §12.3.
 *
 * The turn coordinator raises this once the seven pre-run checks pass and the
 * lease is acquired, so the projection reflects the active run.
 */
export const TradingMissionRunStartedCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.run-started"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  harnessRunId: TrimmedNonEmptyString,
  cause: TradingHarnessRunCause,
  createdAt: IsoDateTime,
});

/**
 * A harness entry request to place a signed order (§17.2).
 *
 * Server-raised (not client-dispatchable): the harness publishes its decision
 * lease proof, and `TradingMissionReactor` runs the §17.2 write side — preview,
 * persist-before-signing, sign in the nonce lane, submit, inspect, reconcile.
 * Carries the `TradingOrderIntent` verbatim plus the authority version + harness
 * run that own the decision lease, so preview can reject a stale run before it
 * mutates durable state (§18 optimistic versioning).
 */
export const TradingExecutionRequestedCommand = Schema.Struct({
  type: Schema.Literal("trading.execution.requested"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  intent: TradingOrderIntent,
  /** The authority version the harness saw when it decided; preview rejects a mismatch. */
  expectedAuthorityVersion: NonNegativeInt,
  /** The harness run that owns the decision lease for this mission. */
  activeHarnessRunId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

/**
 * The stop on an open position was moved by the bounded policy tool - plan 24 §5.
 *
 * Only an *accepted* adjustment raises this: a refusal is agent feedback and
 * leaves the resting stop exactly where it was. Carrying both prices is what
 * lets the timeline and the chart draw the step rather than only the level.
 */
export const TradingMissionStopAdjustedCommand = Schema.Struct({
  type: Schema.Literal("trading.mission.stop-adjusted"),
  commandId: CommandId,
  threadId: ThreadId,
  missionId: TradingMissionId,
  market: TrimmedNonEmptyString,
  previousStopPrice: Schema.Number,
  newStopPrice: Schema.Number,
  /** Why the harness said it was moving the stop. Recorded, never trusted. */
  justification: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const InternalTradingCommand = Schema.Union([
  TradingMissionStatusSetCommand,
  TradingMissionStrategyPublishedCommand,
  TradingMissionWatchRegisteredCommand,
  TradingMissionWatchCancelledCommand,
  TradingMissionWatchFiredCommand,
  TradingMissionRunStartedCommand,
  TradingMissionStopAdjustedCommand,
  TradingExecutionRequestedCommand,
]);
export type InternalTradingCommand = typeof InternalTradingCommand.Type;

// -- event payloads ----------------------------------------------------------

/**
 * A client asked for a mission. Nothing is persisted yet: `TradingMissionReactor`
 * performs the write and then raises `trading.mission.status-set`, so the
 * projection only ever reflects state the domain accepted.
 */
export const TradingMissionCreateRequestedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  tradingAccountId: TrimmedNonEmptyString,
  instruction: TrimmedNonEmptyString,
  /**
   * The operator's explicit mandate size, or absent for "resolve it from the
   * live account balance at creation time" — see `MissionCapital`. Optional
   * rather than a sentinel number so the two cases stay distinguishable in the
   * event stream: a mission created without a stated capital records that it
   * was created without one.
   */
  allocatedCapitalUsd: Schema.optional(Schema.Number),
  /** The market the mission is mandated to trade. Absent means the default (ETH). */
  market: Schema.optional(TradingMarket),
  requestedAt: IsoDateTime,
});

/**
 * A user pressed a §14.7 control. The reactor runs the transition through
 * `TradingMissionService`, which is where §11.1 legality is enforced — the
 * request itself is not a promise that it will be accepted.
 */
export const TradingMissionControlRequestedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  control: Schema.Literals([
    "trading.mission.pause",
    "trading.mission.resume",
    "trading.mission.revoke",
  ]),
  targetStatus: TradingMissionStatus,
  requestedAt: IsoDateTime,
});

/**
 * A user pressed a §14.7 risk-reducing button. The reactor runs it through
 * `TradingControlService`; this event is the request, not the outcome.
 */
export const TradingMissionRiskControlRequestedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  control: TradingRiskControl,
  reductionPercent: Schema.optional(TradingReductionPercent),
  requestedAt: IsoDateTime,
});

export const TradingMissionStatusChangedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  status: TradingMissionStatus,
  blockedReason: Schema.NullOr(TradingMissionBlockedReason),
  updatedAt: IsoDateTime,
});

export const TradingMissionStrategyPublishedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const TradingMissionWatchRegisteredPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  watch: PersistedWatch,
  updatedAt: IsoDateTime,
});

export const TradingMissionWatchCancelledPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  watchId: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const TradingMissionWatchFiredPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  watchId: TrimmedNonEmptyString,
  deduplicationKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const TradingMissionRunStartedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  harnessRunId: TrimmedNonEmptyString,
  cause: TradingHarnessRunCause,
  updatedAt: IsoDateTime,
});

export const TradingMissionStopAdjustedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  market: TrimmedNonEmptyString,
  previousStopPrice: Schema.Number,
  newStopPrice: Schema.Number,
  justification: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

/**
 * A harness asked the reactor to execute an order. The reactor runs the §17.2
 * write side (preview → submit → reconcile); this event is the question, the
 * reactor's status-set + persisted records are the answer.
 */
export const TradingExecutionRequestedPayload = Schema.Struct({
  missionId: TradingMissionId,
  threadId: ThreadId,
  intent: TradingOrderIntent,
  expectedAuthorityVersion: NonNegativeInt,
  activeHarnessRunId: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
});

/**
 * A user asked for a manual order. The request, not the outcome: the reactor
 * prepares and submits it, and refusals ride the alert feed.
 */
export const TradingOrderPlaceRequestedPayload = Schema.Struct({
  accountId: Schema.optional(TrimmedNonEmptyString),
  market: TradingMarket,
  side: TradingOrderSide,
  stopPrice: Schema.Number,
  sizeEth: Schema.optional(Schema.Number),
  notionalUsd: Schema.optional(Schema.Number),
  urgency: Schema.optional(TradingUrgency),
  requestedAt: IsoDateTime,
});
export type TradingOrderPlaceRequestedPayload = typeof TradingOrderPlaceRequestedPayload.Type;

export const TRADING_EVENT_TYPES = [
  "trading.mission-create-requested",
  "trading.mission-control-requested",
  "trading.mission-risk-control-requested",
  "trading.mission-status-changed",
  "trading.mission-strategy-published",
  "trading.mission-watch-registered",
  "trading.mission-watch-cancelled",
  "trading.mission-watch-fired",
  "trading.mission-run-started",
  "trading.mission-stop-adjusted",
  "trading.execution-requested",
  "trading.order-place-requested",
] as const;

// -- plan 29 step 8.4: the operator revises a plan by dragging a level -------

/**
 * How the stop half of a plan reconcile ended, as the workspace reads it.
 *
 * Mirrors the server's `PlanStopStatus` one literal for one literal. A drag
 * that publishes is a `plan()` revision, so the operator is owed the same four
 * outcomes the model is: nothing to protect, nothing stated, it moved, or the
 * envelope refused to widen it.
 */
export const TradingPlanStopReconcileStatus = Schema.Literals([
  "no_position",
  "no_stop_stated",
  "unchanged",
  "moved",
  "repaired",
  "refused",
]);
export type TradingPlanStopReconcileStatus = typeof TradingPlanStopReconcileStatus.Type;

/**
 * What the exchange did with the revised plan's stop.
 *
 * `restingStopPrice` is the load-bearing field and the reason this is a
 * structure rather than the warning sentence: when the reconcile refuses, the
 * plan says one price and the exchange rests at another, and a chart that drew
 * only the plan's would be showing the operator a stop they do not have.
 */
export const TradingPlanStopReconcileView = Schema.Struct({
  status: TradingPlanStopReconcileStatus,
  /** The stop price the plan stated, when it stated one. */
  planStopPrice: Schema.NullOr(Schema.Number),
  /** Where the stop actually rests on the exchange. Null when nothing rests. */
  restingStopPrice: Schema.NullOr(Schema.Number),
  /** The refusal in the system's own words, when the stop was refused. */
  refusal: Schema.optional(TrimmedNonEmptyString),
});
export type TradingPlanStopReconcileView = typeof TradingPlanStopReconcileView.Type;

/** Mirrors the server's `TakeProfitOutcomeStatus`, one literal for one literal. */
export const TradingPlanTargetReconcileStatus = Schema.Literals([
  "flat",
  "withdrawn",
  "unchanged",
  "placed",
  "replaced",
  "failed",
]);
export type TradingPlanTargetReconcileStatus = typeof TradingPlanTargetReconcileStatus.Type;

/**
 * What the exchange did with the revised plan's take-profit.
 *
 * Same reason the stop half is carried back: on `failed` the placement could
 * not be confirmed inside the window and nothing was cancelled, so the chart
 * would be drawing a target the exchange does not hold. It self-heals — the
 * watchdog reconciles the same target every ~5s — but a panel that says
 * nothing for the seconds in between is telling the operator something untrue.
 */
export const TradingPlanTargetReconcileView = Schema.Struct({
  status: TradingPlanTargetReconcileStatus,
  /** The target price the pass derived, when the plan produced one. */
  targetPrice: Schema.NullOr(Schema.Number),
  /** Why the pass failed, when it did. */
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type TradingPlanTargetReconcileView = typeof TradingPlanTargetReconcileView.Type;

/**
 * A drag on the chart, on its way to `publishPlan`.
 *
 * The strategy is the eight authored fields verbatim — the same body the model
 * publishes, with exactly one leaf replaced. There is deliberately no
 * "which level moved" field: the server diffs the accepted plan against the
 * one it replaced to compose the journal note, so the note is a fact about what
 * happened rather than a caption the client supplied.
 */
export const OrchestrationReviseTradingPlanInput = Schema.Struct({
  missionId: TradingMissionId,
  /** The mission version the panel last read. A stale one is refused, never retried. */
  expectedMissionVersion: NonNegativeInt,
  strategy: PublishTradingPlanBody,
});
export type OrchestrationReviseTradingPlanInput = typeof OrchestrationReviseTradingPlanInput.Type;

export const OrchestrationReviseTradingPlanResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("accepted"),
    strategy: TradingPlanState,
    /** Everything the publish and its aftermath want said, in prose. */
    warnings: Schema.Array(Schema.String),
    /** Null when the publish never reached the exchange reconcile. */
    stop: Schema.NullOr(TradingPlanStopReconcileView),
    /** The take-profit half of the same reconcile. Null for the same reason. */
    target: Schema.NullOr(TradingPlanTargetReconcileView),
  }),
  Schema.Struct({
    outcome: Schema.Literal("rejected"),
    reason: PublishTradingPlanRejection,
    /** The version the server holds, so the panel can re-read and re-drag. */
    currentVersion: NonNegativeInt,
    detail: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type OrchestrationReviseTradingPlanResult = typeof OrchestrationReviseTradingPlanResult.Type;
