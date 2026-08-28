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
  thesisIndicators,
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

/** Why a validation stopped. */
export const ThesisValidationEndReason = Schema.Literals(["expired", "ended_by_user"]);
export type ThesisValidationEndReason = typeof ThesisValidationEndReason.Type;

/**
 * The intervals a validation may be armed on.
 *
 * Narrower than {@link BacktestInterval} on purpose. Forward evaluation is
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
  /** Set when this bar closed one. */
  readonly exited: ForwardExitEffect | null;
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
}): ForwardStep {
  const { thesis, candles, notionalUsd } = input;
  const index = candles.length - 1;
  const bar = candles[index];
  if (bar === undefined) {
    return { state: input.state, entered: null, exited: null };
  }

  const long = thesis.side === "long";
  const signals = makeThesisSignals({ thesis, candles });
  let state = input.state;
  let entered: ForwardEntryEffect | null = null;
  let exited: ForwardExitEffect | null = null;

  /** Settle the open position and go flat. */
  const settle = (exitPrice: number, exitTime: number, reason: BacktestExitReason): void => {
    const open = state.open;
    if (open === null) return;
    exited = {
      tradeId: open.id,
      entryTime: open.entryTime,
      entryPrice: open.entryPrice,
      exitTime,
      exitPrice,
      exitReason: reason,
      barsHeld: open.barsHeld,
      adverseExcursionUsd: open.adverseExcursionUsd,
    };
    state = { ...state, open: null, pendingExitReason: null };
  };

  // 1. A decided exit leaves at this bar's open. The bar is not held, so its
  //    levels are never consulted — the position was gone before it printed.
  if (state.pendingExitReason !== null && state.open !== null) {
    settle(bar.open, bar.openTime, state.pendingExitReason);
  } else if (state.pendingExitReason !== null) {
    state = { ...state, pendingExitReason: null };
  }

  // 2. Levels, on a position held through this bar.
  if (state.open !== null) {
    const held = { ...state.open, barsHeld: state.open.barsHeld + 1 };
    state = { ...state, open: held };
    const level = settleAgainstBar({ long, bar, open: held, notionalUsd });
    state = { ...state, open: { ...held, adverseExcursionUsd: level.adverseExcursionUsd } };
    if (level.exitPrice !== null) {
      settle(level.exitPrice, bar.closeTime, level.reason as BacktestExitReason);
    }
  }

  // 3. A pending entry fills at this bar's open, then faces this bar itself.
  if (state.pendingEntrySignalTime !== null && state.open === null) {
    const signalIndex = candles.findIndex(
      (candle) => candle.openTime === state.pendingEntrySignalTime,
    );
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
          signalTime: state.pendingEntrySignalTime,
          stopPrice,
          targetPrice,
        };
        const open = {
          id: input.nextTradeId,
          entryTime: bar.openTime,
          entryPrice,
          signalTime: state.pendingEntrySignalTime,
          stopPrice,
          targetPrice,
          barsHeld: 1,
          adverseExcursionUsd: 0,
        };
        state = { ...state, open };
        const level = settleAgainstBar({ long, bar, open, notionalUsd });
        state = { ...state, open: { ...open, adverseExcursionUsd: level.adverseExcursionUsd } };
        if (level.exitPrice !== null) {
          settle(level.exitPrice, bar.closeTime, level.reason as BacktestExitReason);
        }
      }
    }
    state = { ...state, pendingEntrySignalTime: null };
  } else if (state.pendingEntrySignalTime !== null) {
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
  if (willBeFlat && state.pendingEntrySignalTime === null) {
    if (signals.conditionHolds(thesis.entry, index)) {
      state = { ...state, pendingEntrySignalTime: bar.openTime };
    }
  }

  return { state, entered, exited };
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
}): {
  readonly exitPrice: number | null;
  readonly reason: string;
  readonly adverseExcursionUsd: number;
} {
  const { long, bar, open, notionalUsd } = input;
  const size = open.entryPrice > 0 ? notionalUsd / open.entryPrice : 0;
  const worst = long ? bar.low : bar.high;
  const excursion = Math.max(
    open.adverseExcursionUsd,
    (long ? open.entryPrice - worst : worst - open.entryPrice) * size,
  );

  const stopHit =
    open.stopPrice !== null && (long ? bar.low <= open.stopPrice : bar.high >= open.stopPrice);
  if (stopHit) {
    return { exitPrice: open.stopPrice as number, reason: "stop", adverseExcursionUsd: excursion };
  }
  const targetHit =
    open.targetPrice !== null &&
    (long ? bar.high >= open.targetPrice : bar.low <= open.targetPrice);
  if (targetHit) {
    return {
      exitPrice: open.targetPrice as number,
      reason: "target",
      adverseExcursionUsd: excursion,
    };
  }
  return { exitPrice: null, reason: "open", adverseExcursionUsd: excursion };
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
  return indicatorLookbackBars(thesisIndicators(thesis)) + 10;
}

// ---------------------------------------------------------------------------
// the running verdict
// ---------------------------------------------------------------------------

/**
 * How the forward run compares to the backtest that armed it.
 *
 * `tracking` is not a compliment. It means the two expectancies are within a
 * band wide enough that the difference is noise at this sample size, which is
 * the only claim a few dozen trades supports.
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
 * Wide on purpose. Expectancy over tens of trades has a standard error of the
 * same order as the number itself, so a tighter band would report a regime
 * change every time a single trade landed.
 */
export const FORWARD_TRACKING_BAND = 0.5;

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
  comparison: ForwardComparison,
  /** The whole verdict in prose, sample-size honesty included. */
  verdictReason: Schema.String,
  /** Paper only, always. Present so no client has to remember it. */
  paperOnly: Schema.Literal(true),
});
export type ForwardReport = typeof ForwardReport.Type;

const usd = (value: number): string => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;

/**
 * The running verdict: what the paper trades say, and whether it matches what
 * the backtest promised.
 *
 * The sample gate is {@link MIN_REPLAY_SETUPS}, the same floor the backtest
 * uses, and it comes first for the same reason. The numbers are printed
 * underneath it either way — withholding them would be its own dishonesty —
 * but under the floor nothing here calls them evidence, and the comparison is
 * refused outright rather than reported as a small difference between two
 * numbers that are both noise.
 */
export function judgeForward(input: {
  readonly stats: BacktestStats;
  readonly baselineExpectancyUsd: number | null;
  readonly baselineTradesTaken: number | null;
  readonly barsWatched: number;
  readonly hasOpenTrade: boolean;
  readonly status: ThesisValidationStatus;
}): { readonly comparison: ForwardComparison; readonly verdictReason: string } {
  const { stats, baselineExpectancyUsd } = input;
  const taken = stats.tradesTaken;
  const openNote = input.hasOpenTrade
    ? " One paper position is still open and is not counted."
    : "";
  const pausedNote =
    input.status === "paused" ? " This validation is paused, so bars are passing unwatched." : "";

  if (taken < MIN_REPLAY_SETUPS) {
    return {
      comparison: "too_few_trades",
      verdictReason:
        `${taken} paper ${taken === 1 ? "trade" : "trades"} over ${input.barsWatched.toLocaleString("en-US")} ` +
        `watched bars, under the ${MIN_REPLAY_SETUPS} a verdict needs. ` +
        `So far: ${usd(stats.expectancyUsd)} per trade after fees, ${stats.winRatePercent}% hit rate, ` +
        `${usd(stats.maxDrawdownUsd)} deepest drawdown. That is what happened, not evidence of an edge.` +
        openNote +
        pausedNote,
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

  const band = Math.abs(baselineExpectancyUsd) * FORWARD_TRACKING_BAND;
  const delta = stats.expectancyUsd - baselineExpectancyUsd;
  const against =
    `The backtest expected ${usd(baselineExpectancyUsd)} per trade` +
    (input.baselineTradesTaken === null ? "" : ` over ${input.baselineTradesTaken} trades`) +
    ".";

  if (Math.abs(delta) <= band) {
    return {
      comparison: "tracking",
      verdictReason: `${measured} ${against} Forward is tracking the backtest within the noise of this sample.${openNote}${pausedNote}`,
    };
  }
  if (delta > 0) {
    return {
      comparison: "better_than_backtest",
      verdictReason: `${measured} ${against} Forward is running better than the backtest, which is as likely to be luck as edge at this sample size.${openNote}${pausedNote}`,
    };
  }
  return {
    comparison: "worse_than_backtest",
    verdictReason: `${measured} ${against} Forward is running worse than the backtest, which is what an overfit rule looks like on bars it was not fitted to.${openNote}${pausedNote}`,
  };
}

/** The one-line heading a card or an alert uses for a validation. */
export const describeValidation = (thesis: TradingThesis): string => describeThesis(thesis);

/**
 * The alert summary delivered when a validation ends.
 *
 * One line, because it lands in a feed beside price alerts. The report card
 * carries the rest.
 */
export function forwardEndSummary(report: ForwardReport): string {
  const why = report.endReason === "expired" ? "ran its course" : "was ended";
  return `Validation ${why}: ${report.headline}. ${report.verdictReason}`;
}

/** The intervals and durations the tool will accept, as one line for the menu. */
export function renderForwardMenu(): string {
  return [
    `arm a thesis (same shape as trading_backtest) for a duration; interval=${FORWARD_INTERVALS.join("|")}`,
    "actions: arm list pause resume end report",
    `duration from 1 hour to 90 days; under ${MIN_REPLAY_SETUPS} paper trades there is no verdict, only the numbers`,
    "paper only: signals read closed bars and fill at the next bar open, costed like a backtest, and no order is ever placed",
    "to trade a validated idea, publish a plan and enter as normal with this record as context",
  ].join(" · ");
}

export type { BacktestCosts, BacktestInterval };
