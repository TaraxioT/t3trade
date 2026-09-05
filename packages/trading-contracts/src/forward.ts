/**
 * Forward validation: a thesis, watched on live bars, on paper.
 *
 * A backtest answers "would this have worked". It is the cheap question, and
 * it is the one every overfit idea passes. The expensive question is whether
 * the idea still works on bars nobody has seen yet, and the only honest way to
 * ask it is to fix the rule, start a clock, and let the market answer.
 *
 * That is all this is. An armed thesis evaluates on each closed bar of its own
 * market and interval, records what it would have done, and pays the same fees
 * and funding a real trade would have. It never places an order, and there is
 * no code path from here to one — the paper fills live in their own tables and
 * nothing that reports real money reads them. Promotion to a live position is
 * a sentence the user types, answered by the ordinary trading flow with this
 * record as context.
 *
 * ## Why the arithmetic is shared rather than reimplemented
 *
 * Everything here is scored against the backtest that armed it, and two
 * expectancies produced by two pieces of arithmetic are not a comparison. The
 * entry rule comes from {@link makeThesisSignals} and the figures come from
 * {@link summarizeTrades} — the same functions {@link runBacktest} calls. What
 * this module adds is the state machine that turns a batch walk into an
 * incremental one, because forward validation only ever sees one bar at a time.
 *
 * ## The invariant the state machine exists to keep
 *
 * The backtest's rule is that a signal on closed bar `t` fills at bar `t+1`'s
 * open, and that stop and target distances are measured at the signal bar. A
 * forward run must obey it for the comparison to mean anything, but it cannot
 * see bar `t+1` when bar `t` closes. So a fired rule becomes a *pending* fill
 * carried on the validation row, and the next closed bar opens the position at
 * its own open. The same holds for exits by condition or bar limit. Level
 * exits are the one intrabar event and settle on the bar that touched them,
 * with the stop winning a bar that holds both — the identical tie-break, for
 * the identical reason: OHLC cannot say which came first, and resolving it the
 * other way flatters the thesis by exactly the trades whose outcome is unknown.
 *
 * ## The one place the two engines cannot agree exactly
 *
 * A forward step reads a trailing window; the batch engine reads the whole
 * history. For a bounded indicator that is the same number, but ATR is a
 * Wilder average seeded by an SMA, so the two converge on values that differ
 * slightly. `INDICATOR_LOOKBACK_MULTIPLE` bounds the gap to under 0.1% of the
 * reading — well inside display precision — and it moves an ATR-derived stop
 * PRICE only, never which trade is taken or why it ended. The engine agreement
 * test pins the sequence exactly and the price to that bound, so the gap stays
 * a measured property rather than a surprise.
 *
 * @module TradingForwardValidation
 */
import * as Schema from "effect/Schema";

import {
  BacktestCoverage,
  BacktestStats,
  makeThesisSignals,
  summarizeTrades,
  type BacktestCosts,
  type BacktestExitReason,
  type BacktestTrade,
} from "./backtest.ts";
import { indicatorLookbackBars } from "./indicators.ts";
import type { MarketCandle } from "./market.ts";
import { MIN_REPLAY_SETUPS } from "./replay.ts";
import {
  describeThesis,
  THESIS_VOLUME_RATIO_BARS,
  thesisIndicators,
  thesisMetrics,
  TradingThesis,
  type BacktestInterval,
} from "./thesis.ts";

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/**
 * Where a validation is in its life.
 *
 * `paused` is a real state rather than a deletion: the thesis, its baseline
 * and every paper trade it has already taken survive a pause, and resuming
 * carries on the same record. A paused validation evaluates nothing, so the
 * bars that pass under it are simply bars it did not see — which the report
 * says, because a hit rate over a window with a hole in it is not a hit rate
 * over that window.
 */
export const ThesisValidationStatus = Schema.Literals(["armed", "paused", "ended"]);
export type ThesisValidationStatus = typeof ThesisValidationStatus.Type;

/**
 * Why a validation stopped.
 *
 * `superseded` is the refinement ending: a hypothesis whose next version is
 * armed on the same market and interval ends the version before it, in the
 * same call, rather than colliding with the one-per-slot rule. It is not
 * `ended_by_user`, because nobody asked for the old one to stop, and it is not
 * `expired`, because its clock had not run out. The record has to say which.
 */
export const ThesisValidationEndReason = Schema.Literals([
  "expired",
  "ended_by_user",
  "superseded",
]);
export type ThesisValidationEndReason = typeof ThesisValidationEndReason.Type;

/**
 * The intervals a validation may be armed on.
 *
 * Narrower than the backtest's own interval set on purpose. Forward evaluation is
 * driven by the candle subscriptions the watch evaluator already holds, and
 * those cover the five direct intervals. Arming on 4h or 1d would produce a
 * validation whose bars never arrive — a thing that looks armed and is deaf,
 * which is the worst of the available failures. The refusal names the set.
 *
 * It is also the honest answer on sample size: a fortnight of daily bars is
 * fourteen observations, and no exit rule turns that into evidence.
 */
export const FORWARD_INTERVALS = ["1m", "3m", "5m", "15m", "1h"] as const;
export type ForwardInterval = (typeof FORWARD_INTERVALS)[number];

export const isForwardInterval = (interval: string): interval is ForwardInterval =>
  (FORWARD_INTERVALS as ReadonlyArray<string>).includes(interval);

/** The shortest and longest a validation may run for. */
export const MIN_VALIDATION_MS = 60 * 60 * 1_000;
export const MAX_VALIDATION_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * One paper trade. The same shape a backtested trade has, plus the identity
 * and the open-position fields a live record needs.
 *
 * A trade with `exitTime` null is still open: it has an entry, a stop and a
 * target, and no outcome. It counts toward nothing in the report except the
 * sentence saying one is open, because an unrealised paper position is an
 * opinion about the future exactly like an unrealised real one.
 */
export const PaperTrade = Schema.Struct({
  id: Schema.String,
  entryTime: Schema.Number,
  entryPrice: Schema.Number,
  /** The bar whose close fired the rule. Distances were measured here. */
  signalTime: Schema.Number,
  stopPrice: Schema.NullOr(Schema.Number),
  targetPrice: Schema.NullOr(Schema.Number),
  exitTime: Schema.NullOr(Schema.Number),
  exitPrice: Schema.NullOr(Schema.Number),
  exitReason: Schema.NullOr(Schema.String),
  barsHeld: Schema.Number,
  grossUsd: Schema.NullOr(Schema.Number),
  feesUsd: Schema.NullOr(Schema.Number),
  fundingUsd: Schema.NullOr(Schema.Number),
  netUsd: Schema.NullOr(Schema.Number),
  adverseExcursionUsd: Schema.NullOr(Schema.Number),
});
export type PaperTrade = typeof PaperTrade.Type;

/** A settled paper trade, in the shape the shared statistics reduce. */
export const settledAsBacktestTrade = (trade: PaperTrade): BacktestTrade | null =>
  trade.exitTime === null || trade.exitPrice === null || trade.netUsd === null
    ? null
    : {
        entryTime: trade.entryTime,
        entryPrice: trade.entryPrice,
        exitTime: trade.exitTime,
        exitPrice: trade.exitPrice,
        exitReason: (trade.exitReason ?? "window_end") as BacktestExitReason,
        barsHeld: trade.barsHeld,
        grossUsd: trade.grossUsd ?? 0,
        feesUsd: trade.feesUsd ?? 0,
        fundingUsd: trade.fundingUsd ?? 0,
        netUsd: trade.netUsd,
        adverseExcursionUsd: trade.adverseExcursionUsd ?? 0,
      };

// ---------------------------------------------------------------------------
// the incremental state machine
// ---------------------------------------------------------------------------

/**
 * What a validation is carrying between bars.
 *
 * `pendingEntrySignalTime` and `pendingExitReason` are the whole reason this
 * type exists: they hold the one-bar delay that makes a forward run fill where
 * a backtest fills.
 */
export interface ForwardState {
  /** The open paper trade, or null when flat. */
  readonly open: {
    readonly id: string;
    readonly entryTime: number;
    readonly entryPrice: number;
    readonly signalTime: number;
    readonly stopPrice: number | null;
    readonly targetPrice: number | null;
    readonly barsHeld: number;
    readonly adverseExcursionUsd: number;
  } | null;
  /** Open time of the bar whose close fired the entry, awaiting its fill. */
  readonly pendingEntrySignalTime: number | null;
  /** An exit already decided, filling at the next bar's open. */
  readonly pendingExitReason: BacktestExitReason | null;
}

export const EMPTY_FORWARD_STATE: ForwardState = {
  open: null,
  pendingEntrySignalTime: null,
  pendingExitReason: null,
};

/** An entry the caller must persist as a new open paper trade. */
export interface ForwardEntryEffect {
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly signalTime: number;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
}

/** An exit the caller must settle the open paper trade with. */
export interface ForwardExitEffect {
  readonly tradeId: string;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly exitTime: number;
  readonly exitPrice: number;
  readonly exitReason: BacktestExitReason;
  readonly barsHeld: number;
  readonly adverseExcursionUsd: number;
}

/**
 * What one closed bar did to a validation.
 *
 * Deliberately a description rather than a write. The step is pure so it can
 * be tested against the batch engine bar for bar, and the service that owns
 * the tables decides what to do with the answer.
 */
export interface ForwardStep {
  readonly state: ForwardState;
  /** Set when this bar opened a position. */
  readonly entered: ForwardEntryEffect | null;
  /**
   * Every trade this bar closed, in causal order. One bar CAN close two: a
   * pending exit from the previous bar fills at this bar's open, and a
   * pending entry that fills at the same open can hit its own stop or target
   * inside the same bar. The old single-exit shape silently dropped the first
   * of those from the ledger — the exact defect a paper ledger cannot carry.
   * Empty when nothing closed.
   */
  readonly exits: ReadonlyArray<ForwardExitEffect>;
}

/**
 * Advance a validation by one closed bar.
 *
 * `candles` is the trailing window from the archive, oldest first, long enough
 * for every indicator the thesis reads to have converged
 * ({@link forwardWarmupBars}). The bar being evaluated is the LAST one, and it
 * must be closed — a forming bar's high, low and close are all still moving,
 * and a rule read on one fires on a number that later stops being true.
 *
 * The order of operations inside a bar is the order the batch engine settles
 * in, and it is load-bearing:
 *
 *  1. a pending exit fills at this bar's open (the bar it leaves on is not held)
 *  2. otherwise an open position is settled against this bar's levels
 *  3. a pending entry fills at this bar's open, and is then itself exposed to
 *     this bar's levels, because the batch walk starts at the entry bar
 *  4. a new exit is armed off this closed bar
 *  5. a new entry is armed off this closed bar
 */
export function stepForward(input: {
  readonly thesis: TradingThesis;
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly state: ForwardState;
  readonly notionalUsd: number;
  /** Identity for a position this bar opens. The caller supplies it. */
  readonly nextTradeId: string;
  /**
   * The archive's hourly funding rows covering the window, oldest first. Only
   * a `funding_rate_8h` operand reads them, and it reads them through the same
   * stepwise lookup the batch engine uses - which is the whole reason the
   * rows are passed in here rather than looked up separately.
   */
  readonly funding?: ReadonlyArray<{ readonly time: number; readonly fundingRate: number }>;
  /**
   * Every ended occurrence of every event set the thesis anchors on. Loaded
   * fresh by the caller on each sweep, so a date recorded mid-validation
   * takes effect on the next bar.
   */
  readonly eventOccurrences?: ReadonlyArray<{
    readonly eventSetId: string;
    readonly endAt: number;
  }>;
}): ForwardStep {
  const { thesis, candles, notionalUsd } = input;
  const index = candles.length - 1;
  const bar = candles[index];
  if (bar === undefined) {
    return { state: input.state, entered: null, exits: [] };
  }

  const long = thesis.side === "long";
  const signals = makeThesisSignals({
    thesis,
    candles,
    ...(input.funding === undefined ? {} : { funding: input.funding }),
    ...(input.eventOccurrences === undefined ? {} : { eventOccurrences: input.eventOccurrences }),
  });
  let state = input.state;
  let entered: ForwardEntryEffect | null = null;
  // Every settlement this bar produces, in the order it happened. Overwriting
  // a single exit variable — the defect this repairs — lost whichever trade
  // settled first whenever one bar closed two.
  const exits: Array<ForwardExitEffect> = [];

  /** Settle the open position and go flat. */
  const settle = (exitPrice: number, exitTime: number, reason: BacktestExitReason): void => {
    const open = state.open;
    if (open === null) return;
    exits.push({
      tradeId: open.id,
      entryTime: open.entryTime,
      entryPrice: open.entryPrice,
      exitTime,
      exitPrice,
      exitReason: reason,
      barsHeld: open.barsHeld,
      adverseExcursionUsd: open.adverseExcursionUsd,
    });
    state = { ...state, open: null, pendingExitReason: null };
  };

  // 1. A decided exit leaves at this bar's open. The bar is not held, so its
  //    levels are never consulted — the position was gone before it printed.
  //    `settle` clears the flag itself; the trailing clear is for the case
  //    where an exit was pending with no position left to settle.
  if (state.pendingExitReason !== null) {
    settle(bar.open, bar.openTime, state.pendingExitReason);
    state = { ...state, pendingExitReason: null };
  }

  // 2. Levels, on a position held through this bar.
  if (state.open !== null) {
    const held = { ...state.open, barsHeld: state.open.barsHeld + 1 };
    const level = settleAgainstBar({ long, bar, open: held, notionalUsd });
    state = { ...state, open: { ...held, adverseExcursionUsd: level.adverseExcursionUsd } };
    if (level.exitPrice !== null) {
      settle(level.exitPrice, bar.closeTime, level.reason);
    }
  }

  // 3. A pending entry fills at this bar's open, then faces this bar itself.
  //    Every path below clears the pending signal: filled, unpriced, or not
  //    flat to take it.
  const pendingSignalTime = state.pendingEntrySignalTime;
  if (pendingSignalTime !== null) {
    // Scanned from the end: the signal bar is the one before this one, so a
    // forward scan would walk the whole window to reach it.
    const signalIndex =
      state.open === null
        ? candles.findLastIndex((candle) => candle.openTime === pendingSignalTime)
        : -1;
    const entryPrice = bar.open;
    if (signalIndex >= 0 && entryPrice > 0) {
      const stopDistance = signals.distanceInPrice(
        thesis.exits.stop,
        signalIndex,
        entryPrice,
        undefined,
      );
      const targetDistance = signals.distanceInPrice(
        thesis.exits.target,
        signalIndex,
        entryPrice,
        stopDistance,
      );
      // A setup whose exits cannot be priced is not entered, exactly as the
      // batch engine counts it unpriced rather than trading it blind.
      const priced =
        (thesis.exits.stop === undefined || stopDistance !== undefined) &&
        (thesis.exits.target === undefined || targetDistance !== undefined);
      if (priced) {
        const stopPrice =
          stopDistance === undefined
            ? null
            : long
              ? entryPrice - stopDistance
              : entryPrice + stopDistance;
        const targetPrice =
          targetDistance === undefined
            ? null
            : long
              ? entryPrice + targetDistance
              : entryPrice - targetDistance;
        entered = {
          entryTime: bar.openTime,
          entryPrice,
          signalTime: pendingSignalTime,
          stopPrice,
          targetPrice,
        };
        const open = { id: input.nextTradeId, ...entered, barsHeld: 1, adverseExcursionUsd: 0 };
        const level = settleAgainstBar({ long, bar, open, notionalUsd });
        state = { ...state, open: { ...open, adverseExcursionUsd: level.adverseExcursionUsd } };
        if (level.exitPrice !== null) {
          settle(level.exitPrice, bar.closeTime, level.reason);
        }
      }
    }
    state = { ...state, pendingEntrySignalTime: null };
  }

  // 4. Arm an exit off this closed bar, for a position that survived it.
  if (state.open !== null && state.pendingExitReason === null) {
    const maxHoldBars = thesis.exits.maxHoldBars;
    const opposite = thesis.exits.opposite;
    if (opposite !== undefined && signals.conditionHolds(opposite, index)) {
      state = { ...state, pendingExitReason: "exit_condition" };
    } else if (maxHoldBars !== undefined && state.open.barsHeld >= maxHoldBars) {
      state = { ...state, pendingExitReason: "max_hold" };
    }
  }

  // 5. Arm an entry off this closed bar. Allowed while an exit is already
  //    pending, because by the next bar's open the position will be gone —
  //    which is the batch engine's own resume rule, stated forward.
  const willBeFlat = state.open === null || state.pendingExitReason !== null;
  if (willBeFlat && state.pendingEntrySignalTime === null && signals.entryFires(index)) {
    state = { ...state, pendingEntrySignalTime: bar.openTime };
  }

  return { state, entered, exits };
}

/**
 * A held position against one bar: did a level go, and how far offside did it
 * get. The stop is checked first, so a bar holding both settles as the stop.
 */
function settleAgainstBar(input: {
  readonly long: boolean;
  readonly bar: MarketCandle;
  readonly open: {
    readonly entryPrice: number;
    readonly stopPrice: number | null;
    readonly targetPrice: number | null;
    readonly adverseExcursionUsd: number;
  };
  readonly notionalUsd: number;
}):
  | {
      readonly exitPrice: number;
      readonly reason: BacktestExitReason;
      readonly adverseExcursionUsd: number;
    }
  | { readonly exitPrice: null; readonly adverseExcursionUsd: number } {
  const { long, bar, open, notionalUsd } = input;
  const size = open.entryPrice > 0 ? notionalUsd / open.entryPrice : 0;
  const worst = long ? bar.low : bar.high;
  const excursion = Math.max(
    open.adverseExcursionUsd,
    (long ? open.entryPrice - worst : worst - open.entryPrice) * size,
  );

  // One fill model, stated once and shared with the batch engine
  // (`settleOnBars`): a STOP is a stop-market order, and a bar that OPENS
  // beyond the stop fills at the open — the gap-through price the position
  // holder actually receives, never the flattering stop level. A TARGET is a
  // resting limit, and a bar that opens beyond it fills at the open too,
  // which for a limit is the BETTER price. Levels inside the bar without a
  // gap fill at the level itself.
  const stopFill = (stopPrice: number): number =>
    long ? Math.min(stopPrice, bar.open) : Math.max(stopPrice, bar.open);
  const targetFill = (targetPrice: number): number =>
    long ? Math.max(targetPrice, bar.open) : Math.min(targetPrice, bar.open);

  // Tested in this order so a bar holding both levels settles as the stop.
  if (open.stopPrice !== null && (long ? bar.low <= open.stopPrice : bar.high >= open.stopPrice)) {
    return { exitPrice: stopFill(open.stopPrice), reason: "stop", adverseExcursionUsd: excursion };
  }
  if (
    open.targetPrice !== null &&
    (long ? bar.high >= open.targetPrice : bar.low <= open.targetPrice)
  ) {
    return {
      exitPrice: targetFill(open.targetPrice),
      reason: "target",
      adverseExcursionUsd: excursion,
    };
  }
  return { exitPrice: null, adverseExcursionUsd: excursion };
}

/**
 * How many trailing bars an evaluation needs to read.
 *
 * The indicator library's own convergence rule, plus a small margin for the
 * two bars a cross compares and the bar being evaluated. Reading fewer would
 * let a seeded EMA sit far enough from its converged value to report a cross
 * the chart does not show — which in a forward run becomes a paper trade that
 * never should have existed.
 */
export function forwardWarmupBars(thesis: TradingThesis): number {
  // The antecedent has to be evaluable on every bar of its own window, so the
  // reach is its lookback PLUS how far back the entry is allowed to look for
  // it. `volume_ratio` carries a lookback the indicator library knows nothing
  // about, and a thesis reading it on an under-warmed window would score the
  // early bars as "no signal" rather than "not known yet".
  const metrics = thesisMetrics(thesis);
  const paceBars = metrics.includes("volume_ratio") ? THESIS_VOLUME_RATIO_BARS : 0;
  const sequenceBars = thesis.after?.withinBars ?? 0;
  return Math.max(indicatorLookbackBars(thesisIndicators(thesis)), paceBars) + sequenceBars + 10;
}

// ---------------------------------------------------------------------------
// the running verdict
// ---------------------------------------------------------------------------

/**
 * How the forward run compares to the backtest that armed it.
 *
 * `tracking` is not a compliment. It means the two expectancies are inside a
 * fixed heuristic band — see {@link FORWARD_TRACKING_BAND} — and the only
 * claim a few dozen trades supports is "not visibly different yet".
 *
 * `no_baseline` covers every way there is no honest comparison: no backtest
 * was recorded at all, or the one that was recorded is itself ungradeable —
 * too few trades, or a window the archive served too incompletely for its
 * figures to mean anything. The verdict sentence says which, because those
 * are different facts about the run.
 */
export const ForwardComparison = Schema.Literals([
  "tracking",
  "better_than_backtest",
  "worse_than_backtest",
  "no_baseline",
  "too_few_trades",
]);
export type ForwardComparison = typeof ForwardComparison.Type;

/**
 * The band, as a share of the backtested expectancy, inside which forward and
 * backtest are called the same.
 *
 * Wide on purpose, and a HEURISTIC rather than a statistic: expectancy over
 * tens of trades has a standard error of the same order as the number itself,
 * and no sampling distribution is computed here. A tighter band would report
 * a regime change every time a single trade landed; claiming this one is a
 * confidence interval would be a stronger claim than the arithmetic makes.
 */
export const FORWARD_TRACKING_BAND = 0.5;

/**
 * The calculation version of this module's shared arithmetic. Stamped on
 * composed reports so a saved verdict can say which engine produced it;
 * bumped when the arithmetic that produces a comparison changes.
 */
export const FORWARD_CALCULATION_VERSION = "forward-1";

/** The content digest of one event set, pinned where a saved evaluation read it. */
export const EventSetContentDigest = Schema.Struct({
  eventSetId: Schema.String,
  /** Hex sha256 over the set's canonical content serialization. */
  digest: Schema.String,
});
export type EventSetContentDigest = typeof EventSetContentDigest.Type;

/**
 * Identity of the backtest a forward run is scored against, when the caller
 * recorded one. Every field is absent-or-null rather than fabricated: a
 * baseline written before this existed decodes with no source, and a surface
 * can say "provenance not recorded" instead of guessing.
 */
export const ForwardBaselineSource = Schema.Struct({
  /** The persisted backtest run the figures came from, when one was filed. */
  runId: Schema.NullOr(Schema.String),
  /**
   * sha256 over {@link serializeForwardBaselineContent}, pinning the exact
   * thesis, window, costs and figures the comparison was armed against.
   */
  digest: Schema.NullOr(Schema.String),
  /** When the baseline backtest ran — the as-of cutoff of its archive read. */
  computedAt: Schema.Number,
  /** What the baseline's window actually served, when that was recorded. */
  coverage: Schema.optional(BacktestCoverage),
  /** Content digests of the event sets the baseline read, when it read any. */
  eventSetContentDigests: Schema.optional(Schema.Array(EventSetContentDigest)),
});
export type ForwardBaselineSource = typeof ForwardBaselineSource.Type;

export const ForwardReport = Schema.Struct({
  validationId: Schema.String,
  thesis: TradingThesis,
  headline: Schema.String,
  status: ThesisValidationStatus,
  armedAt: Schema.Number,
  expiresAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  endReason: Schema.NullOr(ThesisValidationEndReason),
  notionalUsd: Schema.Number,
  /** Closed bars this validation actually watched. */
  barsWatched: Schema.Number,
  /** Settled paper trades. An open one is counted by `openTrade`, not here. */
  stats: BacktestStats,
  /** The paper position currently open, when there is one. */
  openTrade: Schema.NullOr(PaperTrade),
  /** Expectancy per trade the backtest reported when this was armed. */
  baselineExpectancyUsd: Schema.NullOr(Schema.Number),
  baselineWinRatePercent: Schema.NullOr(Schema.Number),
  baselineTradesTaken: Schema.NullOr(Schema.Number),
  /**
   * Which backtest those baseline figures came from, when that was recorded.
   * Absent on rows armed before provenance was kept — never invented.
   */
  baselineSource: Schema.optional(ForwardBaselineSource),
  comparison: ForwardComparison,
  /** The whole verdict in prose, sample-size honesty included. */
  verdictReason: Schema.String,
  /** Paper only, always. Present so no client has to remember it. */
  paperOnly: Schema.Literal(true),
  /**
   * The engine version whose arithmetic produced these figures. Present on
   * reports composed by this build; absent on shapes decoded from before it.
   */
  calculationVersion: Schema.optional(Schema.String),
});
export type ForwardReport = typeof ForwardReport.Type;

const usd = (value: number): string => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;

/**
 * Key-sorted, undefined-dropping canonical JSON — the same normalization
 * {@link thesesMatch} applies, stated here so the baseline digest below is a
 * function of content rather than of which build serialized it.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonical(source[key]);
    }
    return out;
  }
  return value;
};

/**
 * The canonical serialization a baseline's content identity is taken over:
 * every field of the backtest report that the comparison could be explained
 * by — thesis, notional, costs, coverage, stats, verdict — under a version
 * tag. Hash it (the server uses sha256 over the utf8 string) and the baseline
 * a validation was armed with is pinned: recomputing the same backtest later
 * yields the same digest, and any change to the numbers does not.
 */
export function serializeForwardBaselineContent(input: {
  readonly report: {
    readonly thesis: unknown;
    readonly notionalUsd: number;
    readonly costs: unknown;
    readonly coverage: unknown;
    readonly stats: unknown;
    readonly verdict: string;
  };
}): string {
  return JSON.stringify([
    "trading_forward.baseline.v1",
    canonical(input.report.thesis),
    input.report.notionalUsd,
    canonical(input.report.costs),
    canonical(input.report.coverage),
    canonical(input.report.stats),
    input.report.verdict,
  ]);
}

/**
 * How much of the baseline's requested window must actually have been served
 * before its figures are a comparison. A majority-missing window is the line:
 * past it the baseline measured something other than the window it claims,
 * and any delta against it decorates a number that never was one.
 */
export const FORWARD_BASELINE_MIN_SERVED_SHARE = 0.5;

/**
 * Whether a baseline's archive window was served completely enough to compare
 * against. Gaps count as missing (the schema clips them to the window
 * already), and so do unserved edges; together they must not outweigh what
 * was served.
 */
export function baselineCoverageIncomplete(coverage: BacktestCoverage): boolean {
  if (coverage.servedFromT === null || coverage.servedToT === null) return true;
  const span = coverage.requestedToT - coverage.requestedFromT;
  if (span <= 0) return false;
  const gapMs = coverage.gaps.reduce((sum, gap) => sum + (gap.toT - gap.fromT), 0);
  const unservedMs =
    Math.max(0, coverage.servedFromT - coverage.requestedFromT) +
    Math.max(0, coverage.requestedToT - coverage.servedToT);
  return gapMs + unservedMs > span * (1 - FORWARD_BASELINE_MIN_SERVED_SHARE);
}

/**
 * The running verdict: what the paper trades say, and whether it matches what
 * the backtest promised.
 *
 * Two sample gates come before any comparison, in this order. The forward
 * run's own floor first — {@link MIN_REPLAY_SETUPS}, the same floor the
 * backtest uses — and then the baseline's: a recorded baseline that itself
 * took too few trades, or whose window the archive served too incompletely,
 * is refused as no baseline at all rather than measured against, because a
 * delta against an ungradeable number decorates nothing. The numbers are
 * printed underneath both gates either way — withholding them would be its
 * own dishonesty — but under a floor nothing here calls them evidence.
 */
export function judgeForward(input: {
  readonly stats: BacktestStats;
  readonly baselineExpectancyUsd: number | null;
  readonly baselineTradesTaken: number | null;
  readonly barsWatched: number;
  readonly hasOpenTrade: boolean;
  readonly status: ThesisValidationStatus;
  /**
   * What the baseline's own window served, when that was recorded. A baseline
   * whose window was served too incompletely to mean anything is refused as
   * a comparison rather than measured against.
   */
  readonly baselineCoverage?: BacktestCoverage | undefined;
  /**
   * True when the thesis anchors on event sets and at least one anchored set
   * has no completed occurrence inside the run yet, so no signal has ever
   * been due. An empty ledger in that state is waiting, not failing.
   */
  readonly awaitingEvent?: boolean | undefined;
}): { readonly comparison: ForwardComparison; readonly verdictReason: string } {
  const { stats, baselineExpectancyUsd } = input;
  const taken = stats.tradesTaken;
  const openNote = input.hasOpenTrade
    ? " One paper position is still open and is not counted."
    : "";
  const pausedNote =
    input.status === "paused" ? " This validation is paused, so bars are passing unwatched." : "";
  // The waiting note rides the below-floor branch only: past the floor the
  // run has signals on record and is not waiting for anything.
  const waitingNote =
    input.awaitingEvent === true && taken < MIN_REPLAY_SETUPS
      ? " This thesis anchors on an event set whose next occurrence is still ahead, so no signal has been due yet — waiting, not failing."
      : "";

  if (taken < MIN_REPLAY_SETUPS) {
    return {
      comparison: "too_few_trades",
      verdictReason:
        `${taken} paper ${taken === 1 ? "trade" : "trades"} over ${input.barsWatched.toLocaleString("en-US")} ` +
        `watched bars, under the ${MIN_REPLAY_SETUPS} a verdict needs. ` +
        `So far: ${usd(stats.expectancyUsd)} per trade after fees, ${stats.winRatePercent}% hit rate, ` +
        `${usd(stats.maxDrawdownUsd)} deepest drawdown. That is what happened, not evidence of an edge.` +
        openNote +
        pausedNote +
        waitingNote,
    };
  }

  const measured =
    `${usd(stats.expectancyUsd)} per trade after fees across ${taken} paper trades, ` +
    `${stats.winRatePercent}% hit rate, ${usd(stats.maxDrawdownUsd)} deepest drawdown.`;

  if (baselineExpectancyUsd === null) {
    return {
      comparison: "no_baseline",
      verdictReason: `${measured} No backtest was recorded when this was armed, so there is nothing to compare it against.${openNote}${pausedNote}`,
    };
  }

  // The baseline's own sample gate, BEFORE any comparison is attempted. A
  // zero-trade or near-zero-trade baseline produces an expectancy of zero
  // that says nothing, and a positive delta against it would read as
  // "better than backtest" while meaning "better than nothing measured".
  // `no_baseline` rather than a measurement, with the reason said out loud.
  if (input.baselineTradesTaken !== null && input.baselineTradesTaken < MIN_REPLAY_SETUPS) {
    return {
      comparison: "no_baseline",
      verdictReason:
        `${measured} A backtest baseline was recorded, but it took only ` +
        `${input.baselineTradesTaken} ${input.baselineTradesTaken === 1 ? "trade" : "trades"} — ` +
        `under the ${MIN_REPLAY_SETUPS} a comparison needs — so there is no gradeable backtest ` +
        `to compare against.${openNote}${pausedNote}`,
    };
  }
  if (input.baselineCoverage !== undefined && baselineCoverageIncomplete(input.baselineCoverage)) {
    return {
      comparison: "no_baseline",
      verdictReason:
        `${measured} A backtest baseline was recorded, but the archive served too little of its ` +
        `window for its figures to be a comparison, so it is refused rather than measured ` +
        `against.${openNote}${pausedNote}`,
    };
  }

  const band = Math.abs(baselineExpectancyUsd) * FORWARD_TRACKING_BAND;
  const delta = stats.expectancyUsd - baselineExpectancyUsd;
  const against =
    `The backtest expected ${usd(baselineExpectancyUsd)} per trade` +
    (input.baselineTradesTaken === null ? "" : ` over ${input.baselineTradesTaken} trades`) +
    ".";
  // Matching a baseline that loses money is replication, not success. The
  // sentence has to carry that, because the token alone ("tracking") reads
  // as good news to anybody who has not read this module.
  const losingBaselineNote =
    baselineExpectancyUsd < 0
      ? " Both figures lose money after fees; matching a losing backtest is replication, not a result."
      : "";

  if (Math.abs(delta) <= band) {
    return {
      comparison: "tracking",
      verdictReason:
        `${measured} ${against} Forward is tracking the backtest, within the heuristic ` +
        `±${usd(band)} band — not a computed sampling distribution.` +
        losingBaselineNote +
        openNote +
        pausedNote,
    };
  }
  if (delta > 0) {
    return {
      comparison: "better_than_backtest",
      verdictReason:
        `${measured} ${against} Forward is running better than the backtest, which is as likely to be ` +
        `luck as edge at this sample size.` +
        (baselineExpectancyUsd < 0 ? " The forward figure still loses money after fees." : "") +
        openNote +
        pausedNote,
    };
  }
  return {
    comparison: "worse_than_backtest",
    verdictReason: `${measured} ${against} Forward is running worse than the backtest, which is what an overfit rule looks like on bars it was not fitted to.${openNote}${pausedNote}`,
  };
}

// ---------------------------------------------------------------------------
// what a validation does while nobody is watching
// ---------------------------------------------------------------------------

/**
 * What happened to a validation between one evaluation and the next.
 *
 * A validation used to be a thing that ran in silence and spoke once, at
 * expiry. Everything interesting about it happens in between: it opens a paper
 * trade, it closes one, and the verdict it is accumulating flips from
 * `tracking` to `worse_than_backtest`. None of that reached any agent, so the
 * only account of an idea being tested was a report nobody read until the
 * clock ran out.
 *
 * These four are the moments worth waking someone for, and nothing else is.
 * A bar that changed no state is not an event; neither is an unchanged
 * verdict, which is the state a validation is in on nearly every bar.
 */
export const ValidationEventKind = Schema.Literals([
  "paper_entry",
  "paper_exit",
  "verdict_change",
  "expiry",
]);
export type ValidationEventKind = typeof ValidationEventKind.Type;

/**
 * Everything one validation did in one evaluation pass, as a single record.
 *
 * Coalesced by construction rather than by a consumer. A pass that catches up
 * on a stretch of missed bars can open and close several paper trades, and
 * delivering those as separate wakes would spend a turn each on a story that
 * is one paragraph long. `lines` holds them in the order they happened; the
 * numbers beside it are the state after all of them.
 */
export const ValidationEventBatch = Schema.Struct({
  validationId: Schema.String,
  /** The filed idea this run belongs to, when it belongs to one. */
  hypothesisId: Schema.NullOr(Schema.String),
  /** The thread that armed it, when one did. */
  threadId: Schema.NullOr(Schema.String),
  market: Schema.String,
  interval: Schema.String,
  /** The validation's own heading: its label, or its thesis in one line. */
  label: Schema.String,
  occurredAt: Schema.Number,
  /** Deduplicated, in the order the kinds first occurred in this pass. */
  kinds: Schema.Array(ValidationEventKind),
  /** One composed sentence per event, oldest first. */
  lines: Schema.Array(Schema.String),
  /** The running verdict after this pass. */
  comparison: ForwardComparison,
  /** The verdict before it, present only when this pass changed it. */
  previousComparison: Schema.optional(ForwardComparison),
  /** Settled paper trades so far, and their net after fees and funding. */
  tradesTaken: Schema.Number,
  netUsd: Schema.Number,
});
export type ValidationEventBatch = typeof ValidationEventBatch.Type;

/** How a comparison label reads in a sentence rather than as a token. */
export const describeComparison = (comparison: ForwardComparison): string => {
  switch (comparison) {
    case "tracking":
      return "tracking the backtest";
    case "better_than_backtest":
      return "better than the backtest";
    case "worse_than_backtest":
      return "worse than the backtest";
    case "no_baseline":
      return "running with no backtest to compare against";
    case "too_few_trades":
      return "still short of the trades a verdict needs";
  }
};

/** `paper long opened on ETH at 2451` — one entry, in the register a rug uses. */
export const describePaperEntry = (input: {
  readonly market: string;
  readonly direction: "long" | "short";
  readonly price: number;
}): string => `paper ${input.direction} opened on ${input.market} at ${input.price}`;

/** `paper long closed on ETH at 2463, net $8.40 (target)` — one exit. */
export const describePaperExit = (input: {
  readonly market: string;
  readonly direction: "long" | "short";
  readonly price: number;
  readonly netUsd: number;
  readonly reason: string | null;
}): string =>
  `paper ${input.direction} closed on ${input.market} at ${input.price}, net ` +
  `${usd(input.netUsd)}${input.reason === null ? "" : ` (${input.reason})`}`;

/** `verdict now worse than the backtest, was tracking the backtest`. */
export const describeVerdictChange = (input: {
  readonly from: ForwardComparison | null;
  readonly to: ForwardComparison;
}): string =>
  `verdict now ${describeComparison(input.to)}` +
  (input.from === null ? "" : `, was ${describeComparison(input.from)}`);

/**
 * The batch as one line, for an inbox summary or a timeline row.
 *
 * The label leads because a mission may be watching more than one idea and the
 * lines alone do not say which moved.
 */
export const describeValidationEvents = (batch: ValidationEventBatch): string =>
  `${batch.label}: ${batch.lines.join("; ")}`;

/** The one-line heading a card or an alert uses for a validation. */
export const describeValidation = (thesis: TradingThesis): string => describeThesis(thesis);

/**
 * The alert summary delivered when a validation ends.
 *
 * One line, because it lands in a feed beside price alerts. The report card
 * carries the rest.
 */
export function forwardEndSummary(report: ForwardReport): string {
  const why =
    report.endReason === "expired"
      ? "ran its course"
      : report.endReason === "superseded"
        ? "was superseded by a newer version of the idea"
        : "was ended";
  return `Validation ${why}: ${report.headline}. ${report.verdictReason}`;
}

/** The intervals and durations the tool will accept, as one line for the menu. */
export function renderForwardMenu(): string {
  return [
    `arm {thesis, durationHours, label?}; thesis is trading_backtest's shape; interval=${FORWARD_INTERVALS.join("|")}`,
    "actions: arm list pause resume end report; the last four take validationId",
    `durationHours 1 to ${MAX_VALIDATION_HOURS}; under ${MIN_REPLAY_SETUPS} paper trades there is no verdict, only the numbers`,
    "paper only: signals read closed bars and fill at the next bar open, costed like a backtest, and no order is ever placed",
    "metric operands and an after clause evaluate here exactly as in the backtest, off the same archive",
    "to trade a validated idea, publish a plan and enter as normal with this record as context",
  ].join(" · ");
}

export type { BacktestCosts, BacktestInterval };

// ---------------------------------------------------------------------------
// the tool surface
// ---------------------------------------------------------------------------

export const TRADING_VALIDATE_TOOL = "trading_validate";

/**
 * One tool for the whole lifecycle, because every way in needs a way out and
 * a way to see the current state, and six verbs spread over six tools would
 * cost six descriptions in every turn's system prompt.
 *
 * A call with no action returns the menu — the plan 38 disclosure pattern
 * `trading_look({})` and `trading_backtest({})` already establish.
 */
export const TradingValidateAction = Schema.Literals([
  "arm",
  "list",
  "pause",
  "resume",
  "end",
  "report",
]);
export type TradingValidateAction = typeof TradingValidateAction.Type;

/** The longest a validation may be asked for, in hours. Ninety days. */
export const MAX_VALIDATION_HOURS = MAX_VALIDATION_MS / (60 * 60 * 1_000);

export const TradingValidateInput = Schema.Struct({
  /**
   * The mission this research is for, when there is one. A validation touches
   * no mission state and takes no authority from one, so it is optional and it
   * is attribution rather than permission — the same role it plays on
   * `trading_backtest`.
   */
  missionId: Schema.optional(Schema.String),
  action: Schema.optional(TradingValidateAction),
  /** Required by `arm`, ignored elsewhere. */
  thesis: Schema.optional(TradingThesis),
  /** How long to watch for. Required by `arm`. */
  durationHours: Schema.optional(Schema.Number),
  /** A name for the idea, so the chart badge and the report read as English. */
  label: Schema.optional(Schema.String),
  /** Required by `pause`, `resume`, `end` and `report`. */
  validationId: Schema.optional(Schema.String),
  /** Ended validations are off the list unless asked for. */
  includeEnded: Schema.optional(Schema.Boolean),
  /**
   * The filed idea this run validates. On `arm` it stamps the validation with
   * the hypothesis and its current version, and it buys the supersede rule:
   * an armed run of an EARLIER version of the same idea, on the same market
   * and interval, is ended rather than colliding with the one-per-slot limit.
   */
  hypothesisId: Schema.optional(Schema.String),
});
export type TradingValidateInput = typeof TradingValidateInput.Type;

/** One line per validation, for the list. */
export const ForwardListEntry = Schema.Struct({
  validationId: Schema.String,
  headline: Schema.String,
  market: Schema.String,
  interval: Schema.String,
  status: ThesisValidationStatus,
  armedAt: Schema.Number,
  expiresAt: Schema.Number,
  tradesTaken: Schema.Number,
  expectancyUsd: Schema.Number,
});
export type ForwardListEntry = typeof ForwardListEntry.Type;

export const TradingValidateResult = Schema.Struct({
  /** Set by `arm`, `report`, `end` and by an expiry the caller asked about. */
  report: Schema.optional(ForwardReport),
  /** Set by `list`. */
  validations: Schema.optional(Schema.Array(ForwardListEntry)),
  /** What the call did, in one sentence the model can relay. */
  outcome: Schema.optional(Schema.String),
  /** Why a call changed nothing. Present only on a refusal. */
  refused: Schema.optional(Schema.String),
  /** The vocabulary, when this call was the menu call. */
  menu: Schema.optional(Schema.String),
});
export type TradingValidateResult = typeof TradingValidateResult.Type;
