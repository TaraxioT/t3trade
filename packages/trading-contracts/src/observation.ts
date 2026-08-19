/**
 * `trading_look` — the one read, plan 29 step 6.1.
 *
 * Twelve read tools used to answer twelve halves of the same question, and the
 * `TradingWakeupComposer` answered all of it again, differently, on every wake.
 * They are two implementations of "what does the model need to know"; this is
 * the contract for the surviving one, and the composer is its implementation.
 *
 * A `look` is always safe to take and always returns the same shape: the market
 * as it is now, what the mission holds, what it has already done, and one line
 * of cost context. Nothing here gates anything.
 *
 * @module TradingObservation
 */
import { Schema } from "effect";

import { AgentAccountSnapshot, AgentNetPosition, AgentOpenOrder } from "./account-snapshot.ts";
import { TradingCostContext, TradingCostEstimate } from "./costs.ts";
import { TradingTradeHistory } from "./history.ts";
import { IndicatorReading, IndicatorRequest } from "./indicators.ts";
import { AgentMarketSnapshot, MarketCandleSeries, OrderBook, ResolvedMarket } from "./market.ts";
import {
  ObservedMarketStructure,
  StrategyCandidate,
  TimeframeAlignment,
} from "./marketStructure.ts";
import { MarketMicrostructure } from "./microstructure.ts";
import { TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
import { TradingTimeframe } from "./strategy.ts";
import { LevelHistoryEntry, PreviousStructureRead } from "./wakeup.ts";
import { ObservedVolatility } from "./volatility.ts";
import { TradingGetMissionResult } from "./tools.ts";

export const TRADING_LOOK_TOOL = "trading_look";

/**
 * The parts of a look, so a turn can ask for the one it needs.
 *
 * The full read answers what twelve tools used to and is the right shape for
 * an assessment turn. It is the wrong shape for a reaction: a run woken by a
 * fired level wants the last few bars, or the position, or the structure — and
 * paying for the account, the trade history and a multi-timeframe structure
 * read to get one of them is how a mission's context fills up in a handful of
 * wakes.
 *
 * - `market`: the resolved market, the snapshot, the book, microstructure.
 * - `candles`: recent bars and the volatility measured on them.
 * - `structure`: the multi-timeframe read with its scored `candidates[]`.
 * - `position`: what is held, the account behind it, resting orders, and what
 *   closing it costs.
 * - `mission`: mandate, authority, plan, watches, pending executions.
 * - `retrospect`: what the mission has BELIEVED — plan history, journal,
 *   target calibration. Split out of `mission` because it is the half that
 *   grows: a turn reacting to a level that just fired was paying for its own
 *   back-catalogue on every read.
 * - `trades`: this mission's completed orders and round trips.
 */
export const TradingLookScope = Schema.Literals([
  "market",
  "candles",
  "structure",
  "position",
  "mission",
  "retrospect",
  "trades",
]);
export type TradingLookScope = typeof TradingLookScope.Type;

/** Every scope, which is what an omitted `scope` means. */
export const TRADING_LOOK_SCOPES: ReadonlyArray<TradingLookScope> = [
  "market",
  "candles",
  "structure",
  "position",
  "mission",
  "retrospect",
  "trades",
];

/**
 * The most bars a scoped candle read will return.
 *
 * The cap is the schema's, not the caller's: a bounded response is the point,
 * and a bound the model can raise is not a bound. Above this the answer is a
 * chart, and a chart is not something to put in a context window.
 */
export const TRADING_LOOK_MAX_BARS = 200;

/**
 * The bars a `candles` scope echoes when the call named neither `bars` nor
 * `indicators`.
 *
 * Enough chart to see the last few prints; not the whole lookback the
 * measurements were taken over. The lookback is still fetched and still
 * measured — this bounds only what rides back.
 */
export const TRADING_LOOK_DEFAULT_BARS = 20;

/**
 * The most bars a look echoes while the mission holds no position.
 *
 * A stand-aside turn asked for 120 bars and used them to recompute the EMA
 * pair — readings the server had already computed and sent. Across one
 * 23-minute mission that was 293,500 characters of `trading_look`, 82% of the
 * model's entire context, to reach the same "no setup" thirteen times.
 *
 * Flat only. Entry and management turns keep whatever they asked for: the
 * shape of the chart is what a trade is contemplated and managed against.
 *
 * Safe by construction — the measurements and the indicator readings are
 * computed over the full fetched lookback, and only the echoed table is
 * trimmed, so the 21-period EMA the `ema_cross` gates read is unaffected by a
 * 60-bar echo.
 */
export const TRADING_LOOK_FLAT_BAR_CAP = 60;

/**
 * How many bars of chart one look echoes back.
 *
 * Three inputs and one rule. A call that named `bars` gets that many; one that
 * named indicators and no bars gets the readings and no chart (the reading is
 * 140 characters where the window it came from is 18,000); anything else gets
 * a short tail. Then, flat, the answer is capped — see
 * {@link TRADING_LOOK_FLAT_BAR_CAP}.
 */
export function echoedBarsForLook(input: {
  readonly bars?: number | undefined;
  readonly indicators?: ReadonlyArray<unknown> | undefined;
  /** Whether the mission holds a position right now. */
  readonly holdingPosition?: boolean | undefined;
}): number {
  const asked =
    input.bars !== undefined
      ? input.bars
      : (input.indicators ?? []).length > 0
        ? 0
        : TRADING_LOOK_DEFAULT_BARS;
  return input.holdingPosition === true ? asked : Math.min(asked, TRADING_LOOK_FLAT_BAR_CAP);
}

/**
 * How many book levels a side a look echoes.
 *
 * Ten, because that is the depth `microstructure.bookImbalance` scores and
 * `liquidity.nearDepthUsd` sums — the readings the model is pointed at. The
 * twenty the gateway returns made the second half of the book a thing nothing
 * in the response referred to.
 */
export const TRADING_LOOK_BOOK_LEVELS = 10;

/**
 * `market` defaults to the mission's own market. A thread with no live mission
 * may still look at a market — the read is the same answer whoever asks — and
 * gets the market half of the observation with `mission.bound: false`.
 */
export const TradingLookInput = Schema.Struct({
  missionId: Schema.optional(TradingId),
  market: Schema.optional(TradingMarket),
  /**
   * Which parts to read. Omit for all of them — the assessment read. Name one
   * or two to answer a specific question cheaply.
   */
  scope: Schema.optional(Schema.Array(TradingLookScope)),
  /**
   * Catalog keys to fetch by name, each at its published size (plan 38 §2.1).
   *
   * Deliberately plain strings, NOT a literal union: unknown keys are refused
   * by name with the nearest valid key (§2.3 rule 4), which the handler can
   * only do when the key reaches it — an enum here would turn that refusal
   * into a generic schema-decode failure the model cannot act on. Validation
   * lives in `parseTradingLookFetchKey`; `nearestTradingLookKey` names the
   * fix. Absent or empty, the call returns the menu
   * ({@link renderTradingLookMenu}).
   */
  fetch: Schema.optional(Schema.Array(Schema.String)),
  /** The bar interval for the `candles` scope. Defaults to the mission's own. */
  interval: Schema.optional(TradingTimeframe),
  /**
   * How many bars of raw chart the `candles` scope echoes back, newest last.
   * Clamped to {@link TRADING_LOOK_MAX_BARS}. `0` returns no bars at all —
   * the volatility, the freshness and the indicators, and none of the chart.
   *
   * Omitted, the default is {@link TRADING_LOOK_DEFAULT_BARS} — or none, when
   * the call named `indicators`. A call that said what it wanted read off the
   * bars has already read them; echoing the window as well was 18k characters
   * of context nobody asked for (plan 34 step 1.1). The measurements are
   * always taken over the full fetched lookback whatever this says.
   */
  bars: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: TRADING_LOOK_MAX_BARS }),
    ),
  ),
  /**
   * Indicator readings computed server-side on the `candles` scope's bars —
   * the model pulls `ema(9)` instead of deriving it from raw bars in context.
   * Each reading returns `value` and `previous` (one bar back), the pair a
   * cross or slope check needs. At most {@link INDICATOR_MAX_REQUESTS} per
   * look. The `ema_cross` pair (9/21) needs none of them: the structure read
   * serves it whole, and `ema` here defaults to 20 — a generic trend read the
   * doctrine has no gate for.
   */
  indicators: Schema.optional(Schema.Array(IndicatorRequest)),
});
export type TradingLookInput = typeof TradingLookInput.Type;

/** The scopes this call asks for — every one, when it named none. */
export function resolveLookScopes(
  input: Pick<TradingLookInput, "scope">,
): ReadonlySet<TradingLookScope> {
  return new Set(
    input.scope === undefined || input.scope.length === 0 ? TRADING_LOOK_SCOPES : input.scope,
  );
}

// -- the fetch catalog (plan 38 §2.2) -----------------------------------------

/** One priced entry in the `fetch` catalog. */
export interface TradingLookCatalogEntry {
  /** The key a call names — the base name, for parameterized entries. */
  readonly key: string;
  /**
   * The published size in characters. For parameterized entries this is the
   * per-unit figure: per bar, per row, per reading, per event.
   */
  readonly chars: number;
  /** The parameter shape, for keys that take one. */
  readonly parameterized?: "<interval>:<n>" | "<W>" | "<n>" | "<spec>";
  /** Served from the market archive, not the exchange (§2.4). */
  readonly archive?: boolean;
  readonly note?: string;
}

/**
 * Everything `trading_look({fetch:[...]})` can serve, at its published price
 * (plan 38 §2.2). Sizes are the plan's measured (m) / estimated (e) figures,
 * copied verbatim — the published price is the contract, and a key whose real
 * size drifts past it is a failing test, not a surprise.
 *
 * `cost` is not in the plan's §2.2 table but §4.2's "nothing is deleted
 * outright" invariant keeps the market scope's 101-char cost line reachable
 * (plan §4.2).
 */
export const TRADING_LOOK_CATALOG: ReadonlyArray<TradingLookCatalogEntry> = [
  { key: "snapshot", chars: 454 },
  { key: "book", chars: 130 },
  { key: "book_full", chars: 898 },
  { key: "microstructure", chars: 599 },
  {
    key: "candles",
    chars: 38,
    parameterized: "<interval>:<n>",
    note: "indicators:<spec> is the cheaper derived alternative (~40 a reading)",
  },
  { key: "indicators", chars: 63, parameterized: "<spec>", note: "~125 for a pair" },
  { key: "volatility", chars: 677 },
  { key: "volatility_htf", chars: 680 },
  { key: "structure", chars: 4375 },
  {
    key: "structure_brief",
    chars: 640,
    note: "alignment + the top candidate, fixture-measured (plan 38 phase 2c)",
  },
  { key: "funding_stats", chars: 140, parameterized: "<W>", archive: true },
  { key: "funding_series", chars: 52, parameterized: "<n>", archive: true },
  { key: "oi_premium", chars: 100, parameterized: "<n>", archive: true },
  { key: "book_history", chars: 89, parameterized: "<n>", archive: true },
  { key: "levels", chars: 886 },
  { key: "position", chars: 180 },
  { key: "position_costs", chars: 900 },
  { key: "orders", chars: 46 },
  { key: "account", chars: 248 },
  { key: "plan", chars: 1258 },
  { key: "watches", chars: 2860 },
  { key: "events", chars: 90, parameterized: "<n>", note: "~90 per event" },
  { key: "journal", chars: 1219 },
  { key: "trades", chars: 1173 },
  { key: "calibration", chars: 1047 },
  { key: "plan_history", chars: 3342 },
  { key: "cost", chars: 101, note: "plan §4.2 — the market scope's cost line stays reachable" },
];

/** The catalog's fixed (non-parameterized) keys, as a type. */
const TRADING_LOOK_FIXED_FETCH_BASES = [
  "snapshot",
  "book",
  "book_full",
  "microstructure",
  "volatility",
  "volatility_htf",
  "structure",
  "structure_brief",
  "levels",
  "position",
  "position_costs",
  "orders",
  "account",
  "plan",
  "watches",
  "journal",
  "trades",
  "calibration",
  "plan_history",
  "cost",
] as const;
export type TradingLookFixedFetchBase = (typeof TRADING_LOOK_FIXED_FETCH_BASES)[number];

/** The most rows an archive-backed series fetch will return. */
export const TRADING_LOOK_MAX_ARCHIVE_ROWS = 200;
/** The window bound on `funding_stats:<W>`, in days. */
export const TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS = 30;
/** The bound on `events:<n>` — the pending-event tail is short by nature. */
export const TRADING_LOOK_MAX_EVENTS = 20;
/** What a bare `events` key serves: the recent tail, uncapped by the caller. */
export const TRADING_LOOK_DEFAULT_EVENTS = 5;

const TRADING_LOOK_INTERVALS: ReadonlyArray<TradingTimeframe> = ["1m", "3m", "5m", "15m", "1h"];

/**
 * The menu the catalog call returns — `trading_look` with no `fetch` and no
 * `scope` (plan 38 §2.3 rule 3). `key=chars` entries, the four archive keys
 * starred, and one legend clause. No descriptions, no prose beyond the legend:
 * the model budgets its own context off this blob (rule 1).
 */
export function renderTradingLookMenu(): string {
  const entries = TRADING_LOOK_CATALOG.map((entry) => {
    const suffix = entry.parameterized === undefined ? "" : paramSuffix(entry.key);
    const star = entry.archive === true ? "*" : "";
    return `${entry.key}${suffix}=${entry.chars}${entry.parameterized === undefined ? "" : "/u"}${star}`;
  });
  return `${entries.join(" ")} — *archive: unavailable+reason, not data; candles: indicators is cheaper`;
}

/** The rendered form of a parameterized key's parameter part. */
function paramSuffix(key: string): string {
  const entry = TRADING_LOOK_CATALOG.find((candidate) => candidate.key === key);
  switch (entry?.parameterized) {
    case "<interval>:<n>":
      return ":tf:n";
    case "<W>":
      return ":d";
    case "<spec>":
      return ":spec";
    default:
      return ":n";
  }
}

/**
 * What `parseTradingLookFetchKey` decided a fetch key means. Invalid
 * parameters carry the named bound so the handler can refuse with the cap in
 * the refusal (§2.3 rule 5), not truncate; unknown keys carry the raw key so
 * the refusal can name the nearest valid one (rule 4).
 */
export type TradingLookFetchParse =
  | { readonly base: "candles"; readonly interval: TradingTimeframe; readonly n: number }
  | { readonly base: "indicators"; readonly spec: string }
  | { readonly base: "funding_stats"; readonly windowDays: number }
  | { readonly base: "funding_series"; readonly n: number }
  | { readonly base: "oi_premium"; readonly n: number }
  | { readonly base: "book_history"; readonly n: number }
  | { readonly base: "events"; readonly n: number; readonly explicit: boolean }
  | { readonly base: TradingLookFixedFetchBase }
  | { readonly base: "invalid_params"; readonly key: string; readonly bound: string }
  | { readonly base: "unknown"; readonly key: string };

/**
 * Parse one `fetch` key into its served meaning. Parameter bounds live here —
 * not in the schema — so the refusal can name the bound.
 */
export function parseTradingLookFetchKey(key: string): TradingLookFetchParse {
  const fixed = TRADING_LOOK_FIXED_FETCH_BASES.find((candidate) => candidate === key);
  if (fixed !== undefined) return { base: fixed };

  const parts = key.split(":");
  const [base, ...params] = parts;
  const n = () => {
    const parsed = Number(params[0]);
    return Number.isInteger(parsed) ? parsed : Number.NaN;
  };

  if (base === "candles") {
    const interval = params[0];
    const bars = Number(params[1]);
    if (!TRADING_LOOK_INTERVALS.includes(interval as TradingTimeframe)) {
      return {
        base: "invalid_params",
        key,
        bound: `interval must be one of ${TRADING_LOOK_INTERVALS.join(",")}`,
      };
    }
    if (!Number.isInteger(bars) || bars < 0 || bars > TRADING_LOOK_MAX_BARS) {
      return { base: "invalid_params", key, bound: `n must be 0..${TRADING_LOOK_MAX_BARS}` };
    }
    return { base: "candles", interval: interval as TradingTimeframe, n: bars };
  }
  if (base === "indicators") {
    if (params.length !== 1 || params[0] === "") {
      return { base: "invalid_params", key, bound: "spec is required" };
    }
    return { base: "indicators", spec: params[0] as string };
  }
  if (base === "events") {
    if (params.length === 0)
      return { base: "events", n: TRADING_LOOK_DEFAULT_EVENTS, explicit: false };
    const rows = n();
    if (!Number.isInteger(rows) || rows < 1 || rows > TRADING_LOOK_MAX_EVENTS) {
      return { base: "invalid_params", key, bound: `n must be 1..${TRADING_LOOK_MAX_EVENTS}` };
    }
    return { base: "events", n: rows, explicit: true };
  }
  if (base === "funding_stats") {
    const days = Number(params[0]);
    if (!Number.isInteger(days) || days < 1 || days > TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS) {
      return {
        base: "invalid_params",
        key,
        bound: `W must be 1..${TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS}`,
      };
    }
    return { base: "funding_stats", windowDays: days };
  }
  for (const seriesBase of ["funding_series", "oi_premium", "book_history"] as const) {
    if (base !== seriesBase) continue;
    const rows = n();
    if (!Number.isInteger(rows) || rows < 1 || rows > TRADING_LOOK_MAX_ARCHIVE_ROWS) {
      return {
        base: "invalid_params",
        key,
        bound: `n must be 1..${TRADING_LOOK_MAX_ARCHIVE_ROWS}`,
      };
    }
    return { base: seriesBase, n: rows };
  }

  return { base: "unknown", key };
}

/**
 * The nearest valid catalog key by edit distance, ties broken by catalog
 * order. Parameterized entries match on their base name — the caller gets
 * `candles` back and supplies `<interval>:<n>` itself.
 */
export function nearestTradingLookKey(key: string): string {
  const target = key.split(":")[0] ?? key;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of TRADING_LOOK_CATALOG) {
    const distance = levenshtein(target, entry.key);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry.key;
    }
  }
  return best ?? key;
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from<number>({ length: b.length + 1 });
  const current = Array.from<number>({ length: b.length + 1 });
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]!;
  }
  return previous[b.length]!;
}

/**
 * Everything one look answers.
 *
 * The market half is always present. The mission half is present whenever the
 * calling thread holds a live mission; `mission.bound` discriminates, and an
 * unbound look still reports the last mission the thread held rather than
 * failing, so a model whose mission just ended can read why.
 */
export const TradingObservation = Schema.Struct({
  observedAt: UnixMillis,
  market: TradingMarket,

  // -- the market, as it is now ----------------------------------------------
  //
  // Every field below is optional for one reason: a look must never fail. The
  // exchange read is the half that can, and the moment it does is exactly when
  // the model most needs to be able to read its own position and mandate. A
  // failed market read costs these fields and nothing else.
  resolvedMarket: Schema.optional(ResolvedMarket),
  snapshot: Schema.optional(AgentMarketSnapshot),
  /**
   * The book, bounded to {@link TRADING_LOOK_BOOK_LEVELS} a side — the depth
   * `microstructure` measures its readings over. Twenty levels rode every
   * market-scope look and no turn ever quoted one (plan 35 phase 3).
   */
  orderBook: Schema.optional(OrderBook),
  /**
   * The lookback window the volatility and structure reads were taken over,
   * as a table rather than one keyed object per bar (plan 35 step 1).
   */
  candles: Schema.optional(MarketCandleSeries),
  /** Fluctuation on the mission's runtime timeframe. Gross of costs. */
  volatility: Schema.optional(ObservedVolatility),
  /**
   * The indicator readings this look asked for, computed on the same bars the
   * candle read fetched. Present only when the call named `indicators`.
   */
  indicators: Schema.optional(Schema.Array(IndicatorReading)),
  /** The same measurement one interval up; absent on the highest interval. */
  higherTimeframeVolatility: Schema.optional(ObservedVolatility),
  /** Direction, alignment, regime, and the scored candidates with their cost. */
  structure: Schema.optional(ObservedMarketStructure),
  /**
   * What the levels near the mark have already done to THIS mission — plan 27
   * B1, grouped with an ATR-scaled tolerance so 1899.7 and 1900.2 are one
   * level.
   *
   * Rides the structure scope because it is read at the same moment as the
   * boundary it qualifies: the `range_reversion` doctrine says a level with
   * two `closedThrough` events is one the market has already gone through
   * twice, and one with a `stopOuts` entry has already ended a trade of this
   * mission's against the thesis. It was gathered by `observe` and dropped at
   * both exits — the doctrine pointed at a field nothing returned.
   */
  levelHistory: Schema.optional(Schema.Array(LevelHistoryEntry)),
  /**
   * The mission's previous structure read — plan 27 B2, and the other half of
   * the same gap.
   *
   * A boundary re-drawn in the same direction as the last read is a range
   * walking, and the walk is the trade. Absent until the mission has read
   * once.
   */
  previousStructureRead: Schema.optional(PreviousStructureRead),
  /**
   * What the book says, as readings — plan 29 phase 7. The same value the wake
   * carries, from the same read: a look and a wake quote one book, never two.
   */
  microstructure: Schema.optional(MarketMicrostructure),
  /**
   * Why the market half is missing, when it is. Present only then, so its
   * absence is the signal that everything above was read.
   */
  marketReadFailed: Schema.optional(Schema.String),

  /**
   * The one line of cost context (plan 29 step 3.1): the round trip in USD and
   * bps at a stated reference notional. Context for whether the expected move
   * pays, never a gate. Absent only when the cost read failed.
   */
  cost: Schema.optional(TradingCostContext),
  /**
   * The round trip on the position actually held, when one is. This is what
   * banking costs; `cost` above prices a hypothetical entry instead.
   */
  positionCosts: Schema.optional(TradingCostEstimate),

  // -- what the mission holds and has done -----------------------------------
  account: Schema.optional(AgentAccountSnapshot),
  /** Flat is `size: 0`, not an absence. Absent only on an unbound look. */
  position: Schema.optional(AgentNetPosition),
  openOrders: Schema.optional(Schema.Array(AgentOpenOrder)),
  /** This mission's completed orders, newest first, with their round trips. */
  trades: Schema.optional(TradingTradeHistory),

  /**
   * Mandate, authority, plan, watches, and pending executions.
   *
   * Optional since plan 38's fetch path: a catalog call or a fetch that named
   * no mission-side key carries no mission half, because the mission row is
   * itself a priced bundle. The scope path always sets it.
   */
  mission: Schema.optional(TradingGetMissionResult),

  // -- the fetch path (plan 38 §2) ---------------------------------------------
  //
  // All optional: the scope path (phases 1–3) never sets them, and the
  // fixture trap in §5.2 only bites required fields.
  /**
   * The menu itself, when this call was the catalog call (`fetch` absent or
   * empty, `scope` absent). The cheapest possible answer to "what can I ask
   * for?" — paid once per mission, not once per wake (§1.5).
   */
  menu: Schema.optional(Schema.String),
  /** The resolved keys this call actually served, echoed back. */
  fetched: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Archive-backed keys that could not be served, with the reason. The reason
   * must never read as data — no zeros, no empty series that would read as
   * "no funding" (§2.4).
   */
  unavailable: Schema.optional(
    Schema.Array(Schema.Struct({ key: Schema.String, reason: Schema.String })),
  ),

  // -- the fetch-only sections (plan 38 §2.2) ----------------------------------
  //
  // Each is one catalog key's answer, in its own field so no key implies
  // another (§2.3 rule 2) and so a size test can measure the section alone.
  /**
   * `book`: the two best levels with their sizes and the summed notional depth
   * over five levels a side — the spread and the liquidity behind it, without
   * the 898 characters of the full ten-level table.
   */
  book: Schema.optional(
    Schema.Struct({
      bid: Schema.Struct({ price: Schema.Number, size: Schema.Number }),
      ask: Schema.Struct({ price: Schema.Number, size: Schema.Number }),
      bidDepth5Usd: Schema.Number,
      askDepth5Usd: Schema.Number,
    }),
  ),
  /**
   * `structure_brief`: the alignment verdict and the single top-scored
   * candidate — the cheap option a reassessment turn currently lacks.
   */
  structureBrief: Schema.optional(
    Schema.Struct({
      alignment: TimeframeAlignment,
      topCandidate: Schema.optional(StrategyCandidate),
    }),
  ),
  /**
   * `events`: the mission's pending-event tail, newest last, uncapped by the
   * scope path. `deduplicationKey` is omitted — the summary and the moment are
   * what a turn reads.
   */
  events: Schema.optional(
    Schema.Array(
      Schema.Struct({ category: Schema.String, occurredAt: UnixMillis, summary: Schema.String }),
    ),
  ),
  /** `funding_stats:<W>`: the trailing window's verdict, from the archive. */
  fundingStats: Schema.optional(
    Schema.Struct({
      windowDays: Schema.Number,
      mean: Schema.Number,
      latestRate: Schema.Number,
      latestTime: UnixMillis,
      signFlips: Schema.Number,
      sampleCount: Schema.Number,
    }),
  ),
  /** `funding_series:<n>`: hourly funding rows, oldest first. */
  fundingSeries: Schema.optional(
    Schema.Array(Schema.Struct({ time: UnixMillis, fundingRate: Schema.Number })),
  ),
  /** `oi_premium:<n>`: asset-context samples, oldest first. */
  oiPremium: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ts: UnixMillis,
        openInterest: Schema.Number,
        premium: Schema.Number,
        oraclePx: Schema.Number,
        markPx: Schema.Number,
      }),
    ),
  ),
  /** `book_history:<n>`: book-summary rows, oldest first. */
  bookHistory: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ts: UnixMillis,
        bidPx: Schema.Number,
        askPx: Schema.Number,
        bidDepth5: Schema.Number,
        askDepth5: Schema.Number,
      }),
    ),
  ),
});
export type TradingObservation = typeof TradingObservation.Type;
