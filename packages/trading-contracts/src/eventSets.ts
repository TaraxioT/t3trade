/**
 * Event sets: the calendar a thesis can be anchored to.
 *
 * A user says "every time after Devcon, ETH goes up about 10 percent". That is
 * a claim about wall-clock dates the market data itself carries no trace of:
 * no indicator, no metric, nothing in the archive says a conference happened.
 * An event set is the missing half: a named list of dated occurrences, each
 * one carrying the source the date came from, recorded once and then available
 * to every thesis, backtest, validation and chart in the environment.
 *
 * The dates are researched, not fetched. The tool that writes these rows never
 * reaches the network: the agent looks the dates up where it already can, and
 * records them with the URL it found them at. An occurrence with no source is
 * a refusal rather than a datum, because a date nobody can check is a number
 * the whole study silently rests on.
 *
 * ## The study is descriptive, and says so
 *
 * {@link runEventStudy} answers the question the user actually asked: what did
 * price do over the next N bars after each occurrence? No fees, no stops, no
 * sizing, no simulation. "How much profit could have been made" is a different
 * question and belongs to `trading_backtest` on an event-anchored thesis,
 * where the whole costs machinery already lives. Duplicating any of that here
 * would give the product two answers to one question.
 *
 * The honesty rule is coverage. Nine occurrences in a set is already a small
 * sample, and the archive can usually see fewer of them than the set holds,
 * because it started recording at some point and the events started happening
 * before that. Every occurrence the study cannot measure is reported with its
 * reason, and the verdict sentence states the fraction plainly ("2 of 9
 * occurrences fall inside archived data") rather than letting a mean of two
 * numbers read as a statement about nine.
 *
 * @module TradingEventSets
 */
import * as Schema from "effect/Schema";

import type { MarketCandle } from "./market.ts";
import { UnixMillis, TradingMarket } from "./primitives.ts";
import { BacktestInterval } from "./thesis.ts";

/**
 * Occurrences one set may hold.
 *
 * A recurring event with more than two hundred recorded dates is a research
 * project, not a trading thesis, and the study's honesty depends on n staying
 * small enough that nobody mistakes it for a sample.
 */
export const EVENT_SET_MAX_OCCURRENCES = 200;

/** Bars forward one event study may measure. A thousand and a day is enough. */
export const EVENT_STUDY_MAX_HORIZON_BARS = 500;

/** The horizon a study runs when the call does not name one: a month of bars. */
export const EVENT_STUDY_DEFAULT_HORIZON_BARS = 30;

/**
 * How a study prices its entry. A readable literal union, deliberately not a
 * strategy abstraction: the study is one descriptive measurement and the
 * basis is one sentence of it, not a slot a caller extends with a third
 * convention.
 *
 * - `first_bar_open_after_event`: the original basis. Entry is the OPEN of
 *   the first candle whose openTime is at or after `endAt`, exit is the close
 *   `horizonBars - 1` bars later. Retained as the decoding default so scenes
 *   persisted before this field existed read back as the numbers they were
 *   computed with, never reinterpreted.
 * - `first_closed_bar_after_event`: entry is the CLOSE of the first candle
 *   whose closeTime is strictly after `endAt` (a bar containing an intrabar
 *   activation closes after the activation), exit is the close a full
 *   `horizonBars` bar intervals later: an ordinary close-to-close lag.
 */
export const EventStudyEntryBasis = Schema.Literals([
  "first_bar_open_after_event",
  "first_closed_bar_after_event",
]);
export type EventStudyEntryBasis = typeof EventStudyEntryBasis.Type;

/**
 * The basis a tool call gets when it does not name one: the close-to-close
 * convention an activation instant asks for, where t0 is a price that existed
 * only once the event had happened. `runEventStudy` and the two window
 * functions still default to the open basis so this module's existing pure
 * callers measure exactly what they measured before; the two defaults meet
 * only at the tool boundary, and the menus say which one a call got.
 */
export const EVENT_STUDY_DEFAULT_ENTRY_BASIS: EventStudyEntryBasis = "first_closed_bar_after_event";

/** The basis as one short phrase, for surfaces that name it beside numbers. */
export const EVENT_STUDY_ENTRY_BASIS_PHRASES: Readonly<Record<EventStudyEntryBasis, string>> = {
  first_closed_bar_after_event: "close of the first closed bar after the event, close to close",
  first_bar_open_after_event: "open of the first bar at or after the event end",
};

/**
 * What a study measures besides the terminal close return.
 *
 * - `forward_return`: the original metric. Entry to the horizon's final close,
 *   one number per occurrence.
 * - `path_extrema`: what happened INSIDE the window, for the question a fixed
 *   horizon cannot answer ("where was the lowest point in the four weeks after
 *   each fork"). Every covered row additionally carries the path extremum
 *   after the defined entry within the horizon — the minimum low for a short,
 *   the maximum high for a long — beside the terminal return, which stays on
 *   the row unchanged. The excursion is descriptive: it is the maximum
 *   favorable excursion after entry, never a realizable strategy result, and
 *   every surface that shows it says so.
 */
export const EventStudyMetric = Schema.Literals(["forward_return", "path_extrema"]);
export type EventStudyMetric = typeof EventStudyMetric.Type;

/** The side whose favorable excursion a `path_extrema` study measures. */
export const EventStudyDirection = Schema.Literals(["short", "long"]);
export type EventStudyDirection = typeof EventStudyDirection.Type;

/** The bar price an extremum is read from: the low for a short, the high for a long. */
export const EventStudyPriceField = Schema.Literals(["low", "high"]);
export type EventStudyPriceField = typeof EventStudyPriceField.Type;

/** The metric a study runs when the call does not name one. */
export const EVENT_STUDY_DEFAULT_METRIC: EventStudyMetric = "forward_return";

/** The resolved study metric: defaults applied, contradictions impossible. */
export type ResolvedEventStudyMetric =
  | { readonly metric: "forward_return" }
  | {
      readonly metric: "path_extrema";
      readonly direction: EventStudyDirection;
      readonly priceField: EventStudyPriceField;
      /**
       * Present when the recipe recorded an excursion threshold: the only
       * form in which a "did it dip massively" question may become a hit
       * rate. Long convention like `excursionReturnPct` (a short's dip
       * threshold is negative), compared against complete rows only.
       */
      readonly excursionThresholdPct?: number;
    };

/**
 * Resolve a study call's metric fields, or refuse. Pure, and the one place the
 * defaults live so the two tool boundaries (`trading_events` study and
 * `trading_chart` publish) resolve identically: the metric defaults to
 * {@link EVENT_STUDY_DEFAULT_METRIC}; `direction` and `priceField` are
 * path_extrema's own (a direction on a forward-return study is a mistake that
 * would silently do nothing, so it is refused, not ignored); path_extrema
 * needs a direction; the price field defaults to the low for a short and the
 * high for a long, and a pair that contradicts itself refuses.
 *
 * An excursion threshold is the one way a "did it dip massively" question
 * becomes a countable hit rate, so it is validated here too rather than
 * anywhere a caller might forget: it applies only to path_extrema, it is a
 * finite nonzero percentage in the same long convention as
 * `excursionReturnPct` (a short's dip threshold is negative), a threshold on
 * a forward-return study is refused rather than silently ignored, and an
 * adverse sign for the chosen direction is refused rather than counted as
 * zero hits. The resolver returns the threshold it validated so every
 * surface reports the same number the hits were counted against.
 */
export function resolveEventStudyMetric(input: {
  readonly metric?: EventStudyMetric | undefined;
  readonly direction?: EventStudyDirection | undefined;
  readonly priceField?: EventStudyPriceField | undefined;
  readonly excursionThresholdPct?: number | undefined;
}): ResolvedEventStudyMetric | { readonly reason: string } {
  const metric = input.metric ?? EVENT_STUDY_DEFAULT_METRIC;
  if (metric === "forward_return") {
    if (input.direction !== undefined || input.priceField !== undefined) {
      return {
        reason:
          "direction and priceField apply only to the path_extrema metric; drop them, or name metric: path_extrema",
      };
    }
    if (input.excursionThresholdPct !== undefined) {
      return {
        reason:
          "excursionThresholdPct applies only to the path_extrema metric; a hit rate needs the excursion it counts, so name metric: path_extrema with a direction",
      };
    }
    return { metric };
  }
  if (input.direction === undefined) {
    return {
      reason:
        "the path_extrema metric needs a direction: short (its excursion is the lowest low) or long (the highest high)",
    };
  }
  const priceField = input.priceField ?? (input.direction === "short" ? "low" : "high");
  if (
    (input.direction === "short" && priceField === "high") ||
    (input.direction === "long" && priceField === "low")
  ) {
    return {
      reason:
        `priceField ${priceField} contradicts direction ${input.direction}: ` +
        "a short's excursion is measured on the low, a long's on the high",
    };
  }
  if (input.excursionThresholdPct !== undefined) {
    if (!Number.isFinite(input.excursionThresholdPct) || input.excursionThresholdPct === 0) {
      return {
        reason:
          "excursionThresholdPct is a finite nonzero percentage in the long convention (a short's dip threshold is negative, a long's spike threshold positive)",
      };
    }
    const adverse =
      (input.direction === "short" && input.excursionThresholdPct > 0) ||
      (input.direction === "long" && input.excursionThresholdPct < 0);
    if (adverse) {
      return {
        reason:
          `excursionThresholdPct ${input.excursionThresholdPct} reads adverse for a ${input.direction}: ` +
          "the threshold counts the direction's favorable excursions, so a short's is negative and a long's positive",
      };
    }
    return {
      metric,
      direction: input.direction,
      priceField,
      excursionThresholdPct: input.excursionThresholdPct,
    };
  }
  return { metric, direction: input.direction, priceField };
}

/**
 * What the recorded timestamps actually claim about the event's time.
 *
 * - `instant`: the event happened at one exact moment (`startAt === endAt`),
 *   the shape a protocol-activation timestamp demands.
 * - `window`: the event ran from one exact moment to another, both supplied.
 * - `date`: the research established whole days, nothing finer. The span is
 *   the UTC midnights around those days, and no consumer may read it as a
 *   claim about a time of day.
 *
 * Optional because every row recorded before the field existed is a span the
 * old parser produced, and those rows decode with the field ABSENT rather
 * than re-derived: a consumer reading them sees "recorded as a span", never a
 * precision nobody declared at the time.
 */
export const TradingEventTimePrecision = Schema.Literals(["instant", "window", "date"]);
export type TradingEventTimePrecision = typeof TradingEventTimePrecision.Type;

/**
 * One dated occurrence of the event, in UTC milliseconds.
 *
 * `startAt` and `endAt` make a multi-day event one occurrence rather than
 * several: a conference is the whole span, and "after Devcon" means after the
 * LAST day, which is why every consumer anchors on `endAt`.
 *
 * `timePrecision` says what those numbers claim (see
 * {@link TradingEventTimePrecision}). It is written by the parser for every
 * new occurrence and left absent for legacy rows; it is never guessed back
 * from the numbers, because a midnight-aligned window and a date span are
 * indistinguishable from the timestamps alone.
 *
 * `source` is where the date came from: a URL the agent can cite back, or the
 * words "user provided" when the user dictated the date. Required and
 * non-empty, because an unsourced date is indistinguishable from an invented
 * one and everything downstream treats these rows as facts.
 */
export const TradingEventOccurrence = Schema.Struct({
  startAt: UnixMillis,
  endAt: UnixMillis,
  timePrecision: Schema.optional(TradingEventTimePrecision),
  label: Schema.optional(Schema.String),
  source: Schema.String,
});
export type TradingEventOccurrence = typeof TradingEventOccurrence.Type;

/**
 * A named set of occurrences: "Devcon", "Solana Breakpoint", "the merge".
 *
 * `retiredAt` is how a set leaves the vocabulary without leaving the data: a
 * retired set refuses in new theses but keeps evaluating in the ones already
 * saved, because a thesis that referenced it when it was live does not become
 * untestable because somebody tidied the list. Null while active.
 */
export const TradingEventSet = Schema.Struct({
  eventSetId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  retiredAt: Schema.NullOr(UnixMillis),
  occurrences: Schema.Array(TradingEventOccurrence),
});
export type TradingEventSet = typeof TradingEventSet.Type;

/**
 * Who wrote an occurrence. The tool is only ever called by a model, so it
 * writes `agent`; the `user` value exists for a surface that can genuinely
 * attribute one, the same rule the hypothesis author follows.
 */
export const EventSetAuthor = Schema.Literals(["user", "agent"]);
export type EventSetAuthor = typeof EventSetAuthor.Type;

/**
 * Everything the schema deliberately does not check about one occurrence, as
 * one refusal the caller can act on. `null` when the occurrence is sound.
 */
export function validateEventOccurrence(occurrence: TradingEventOccurrence): string | null {
  if (occurrence.endAt < occurrence.startAt) {
    return "endAt is before startAt: an occurrence cannot end before it begins";
  }
  if (occurrence.timePrecision === "instant" && occurrence.startAt !== occurrence.endAt) {
    return "an instant occurrence must start and end at the same moment";
  }
  if (occurrence.source.trim().length === 0) {
    return 'source cannot be empty: name the URL or say "user provided", never record a date you cannot check';
  }
  return null;
}

/**
 * The window an event study needs the archive to hold before it runs: from
 * the first required entry bar (the first grid-aligned open at or after the
 * earliest ended occurrence) to the last required exit bar (the declared
 * horizon's final bar after the latest ended occurrence).
 *
 * Occurrences that have not ended yet are excluded — their entry bars do
 * not exist to fetch — and a set with nothing ended, or whose first entry bar has
 * not opened yet, needs nothing: `null`, and the study reports those rows
 * uncovered with their reasons instead of pretending a recovery was possible.
 * This is the bounded context the study itself measures; bars between
 * occurrences arrive with the same window because it is contiguous.
 *
 * The basis moves both ends by at most one bar: the close basis enters on the
 * close of the bar whose open slot the earliest end falls inside (one bar
 * earlier than the open basis looks) and runs one bar further to the exit.
 */
export function eventStudyHydrationWindow(
  occurrences: ReadonlyArray<TradingEventOccurrence>,
  input: {
    readonly intervalMs: number;
    readonly horizonBars: number;
    readonly now: number;
    readonly entryBasis?: EventStudyEntryBasis;
  },
): { readonly fromT: number; readonly toT: number } | null {
  const basis = input.entryBasis ?? "first_bar_open_after_event";
  const ended = occurrences
    .map((occurrence) => occurrence.endAt)
    .filter((endAt) => endAt <= input.now);
  if (ended.length === 0 || input.intervalMs <= 0 || input.horizonBars < 1) return null;
  const earliestEnd = Math.min(...ended);
  const latestEnd = Math.max(...ended);
  const gridOpenContaining = (t: number): number =>
    Math.floor(t / input.intervalMs) * input.intervalMs;
  const gridOpenFollowing = (t: number): number =>
    Math.ceil(t / input.intervalMs) * input.intervalMs;
  const firstEntryT =
    basis === "first_closed_bar_after_event"
      ? gridOpenContaining(earliestEnd)
      : gridOpenFollowing(earliestEnd);
  const lastEntryT =
    basis === "first_closed_bar_after_event"
      ? gridOpenContaining(latestEnd)
      : gridOpenFollowing(latestEnd);
  const lastExitT =
    lastEntryT +
    (basis === "first_closed_bar_after_event"
      ? input.horizonBars * input.intervalMs
      : (input.horizonBars - 1) * input.intervalMs);
  const toT = Math.min(input.now, lastExitT);
  // A horizon-one study of a single occurrence needs exactly one bar — a
  // window whose bounds meet is that bar, not an empty window.
  if (toT < firstEntryT) return null;
  // The first entry bar has not opened yet (an occurrence that ended between
  // grid opens, or exactly at a boundary where that bar is still open):
  // nothing to fetch, the rows stay uncovered with their reason.
  if (firstEntryT >= input.now) return null;
  return { fromT: firstEntryT, toT };
}

/**
 * The window a study READS and budget-checks: the hydration window when any
 * occurrence has ended, and otherwise a two-bar recent tail. The tail exists
 * so a set of only-future occurrences still gets the newest archived bar —
 * `runEventStudy` then reports each row honestly as "still in the future"
 * instead of "the archive holds no bars for this market".
 *
 * This is the one rule both study callers (the `trading_events` study action
 * and `trading_chart`'s publish action) measure against, so the window that
 * is hydrated, the window the bar budget judges, and the window the candles
 * are read from are the same window — never the archive's whole history,
 * which would refuse a small study merely because recording has outgrown it.
 */
export function eventStudyReadWindow(
  occurrences: ReadonlyArray<TradingEventOccurrence>,
  input: {
    readonly intervalMs: number;
    readonly horizonBars: number;
    readonly now: number;
    readonly entryBasis?: EventStudyEntryBasis;
  },
): { readonly fromT: number; readonly toT: number } {
  const hydration = eventStudyHydrationWindow(occurrences, input);
  if (hydration !== null) return hydration;
  return { fromT: input.now - 2 * input.intervalMs, toT: input.now };
}

// ---------------------------------------------------------------------------
// the study
// ---------------------------------------------------------------------------

/** What the study could measure for one occurrence, and what it could not. */
export const EventStudyRow = Schema.Struct({
  startAt: UnixMillis,
  endAt: UnixMillis,
  /**
   * What the occurrence's timestamps claim (see
   * {@link TradingEventTimePrecision}), copied from the occurrence so consumers
   * of a row or its window never guess. Absent on rows recorded before the
   * field existed: a span, with no precision claimed.
   */
  timePrecision: Schema.optional(TradingEventTimePrecision),
  /** The occurrence's own label, when it carries one. */
  label: Schema.optional(Schema.String),
  /** Where the date came from, so the row can be checked. */
  source: Schema.String,
  covered: Schema.Boolean,
  /** Present on every uncovered row: why the archive could not measure it. */
  reason: Schema.optional(Schema.String),
  entryTime: Schema.optional(UnixMillis),
  entryPrice: Schema.optional(Schema.Number),
  exitTime: Schema.optional(UnixMillis),
  exitPrice: Schema.optional(Schema.Number),
  /**
   * Signed, long convention: (exit - entry) / entry as a percentage. The
   * study takes no view on side; a short reads the same number negated.
   */
  returnPct: Schema.optional(Schema.Number),
  /**
   * Present on covered rows of a `path_extrema` study: the open time of the
   * bar holding the path extremum after the defined entry within the measured
   * window (the bars actually covered, when the window truncated). After the
   * entry means after it on the entry basis: on the close basis the entry
   * bar's own wick elapsed before the entry price existed and never counts;
   * on the open basis the entry bar counts, its open being the entry. The
   * open time, not a moment inside the bar: the low printed somewhere in
   * that bar, and the row claims the bar, never a millisecond it cannot
   * know.
   */
  extremumTime: Schema.optional(UnixMillis),
  /** Present with `extremumTime`: the extremum price (a short's lowest low, a long's highest high). */
  extremumPrice: Schema.optional(Schema.Number),
  /**
   * Present on truncated rows: why the measured window stopped short of the
   * horizon — an internal recording gap in the grid, or the archived data
   * simply ending. The two read differently (a data defect versus the present
   * catching up), and a surface may say which. Absent on complete rows and on
   * rows computed before the distinction existed.
   */
  truncationReason: Schema.optional(Schema.String),
  /**
   * Present with `extremumTime`: the excursion to the extremum, signed in the
   * LONG convention like `returnPct` — (extremum - entry) / entry as a
   * percentage. A short's favorable excursion is the NEGATIVE of this number.
   * The terminal `returnPct` is computed separately and both are always
   * present on a covered path_extrema row.
   */
  excursionReturnPct: Schema.optional(Schema.Number),
  /** True when the window ran out before the horizon did. */
  truncated: Schema.Boolean,
  /** Bars actually measured, horizonBars when not truncated. */
  barsCovered: Schema.optional(Schema.Number),
});
export type EventStudyRow = typeof EventStudyRow.Type;

/**
 * The same question asked of every bar rather than every event: what did a
 * horizon-length forward return look like sampled across the whole window?
 * The event's numbers are read against this, because "up 8 percent after
 * Breakpoint" is only interesting if the market was not going up 8 percent
 * over every 30 bars anyway.
 */
export const EventStudyBaseline = Schema.Struct({
  samples: Schema.Number,
  meanReturnPct: Schema.Number,
  medianReturnPct: Schema.Number,
  /**
   * Present when the recipe recorded an excursion threshold: the share of the
   * same complete, unbroken every-bar windows whose post-entry excursion met
   * the threshold, measured with the same entry convention, extremum range
   * and sign convention as the rows. A matched downside-excursion comparison,
   * never a terminal-return one wearing its name; the terminal figures above
   * stay separately labelled whatever else is present.
   */
  excursionThresholdHitRatePercent: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type EventStudyBaseline = typeof EventStudyBaseline.Type;

export const EventStudyReport = Schema.Struct({
  /**
   * The metric this report measured. Absent on reports computed before metrics
   * existed: those are forward_return, and decode without the field rather
   * than being reinterpreted.
   */
  metric: Schema.optional(EventStudyMetric),
  horizonBars: Schema.Number,
  /** The horizon in wall-clock time, for the surfaces that say it in words. */
  horizonMs: Schema.Number,
  n: Schema.Number,
  nCovered: Schema.Number,
  /**
   * Covered rows that measured the FULL horizon on an unbroken grid. The
   * primary aggregates (mean, median, hit rate, best/worst, extrema, the
   * baseline comparison) are over these rows only. Absent on reports computed
   * before the completeness split: those reports mixed partial rows into
   * their means, and they decode as legacy numbers rather than being
   * reinterpreted under the repaired policy.
   */
  nComplete: Schema.optional(Schema.Number),
  /**
   * Covered rows whose measured window stopped short of the horizon. Retained
   * on the report for inspection; excluded from every aggregate. Absent on
   * legacy reports.
   */
  nPartial: Schema.optional(Schema.Number),
  /** Rows the archive could not measure at all (n − nCovered). Absent on legacy reports. */
  nUnavailable: Schema.optional(Schema.Number),
  /**
   * Null when no row completed the full horizon. Never guessed, never zero:
   * an all-partial or all-unavailable study has no full-horizon mean, and
   * reporting 0% would be the one number worse than none.
   */
  meanReturnPct: Schema.NullOr(Schema.Number),
  medianReturnPct: Schema.NullOr(Schema.Number),
  /** Share of covered occurrences with a return above zero. */
  hitRatePercent: Schema.NullOr(Schema.Number),
  bestReturnPct: Schema.NullOr(Schema.Number),
  worstReturnPct: Schema.NullOr(Schema.Number),
  /**
   * Present on path_extrema reports: the mean excursion, in the long
   * convention like the rows. Null when nothing was covered. A maximum
   * favorable excursion is a description of the path, never a realizable
   * return, and no aggregate may present it as one.
   */
  meanExcursionPct: Schema.optional(Schema.NullOr(Schema.Number)),
  /**
   * Present on path_extrema reports: the share of covered rows whose excursion
   * MAGNITUDE exceeds its terminal return magnitude — how often the path went
   * further than it ended, in percent. Null when nothing was covered.
   */
  excursionBeyondTerminalPercent: Schema.optional(Schema.NullOr(Schema.Number)),
  /**
   * Present when the recipe recorded an excursion threshold (path_extrema
   * only): the percentage itself, verbatim, in the long convention. A hit
   * rate is only honest when the number it counted against rides with it.
   */
  excursionThresholdPct: Schema.optional(Schema.Number),
  /** Complete rows whose excursion met the recorded threshold. */
  thresholdHitCount: Schema.optional(Schema.Number),
  /**
   * The hit rate's denominator: COMPLETE rows only. A truncated or uncovered
   * row is not evidence either way about a full-horizon dip.
   */
  thresholdDenominator: Schema.optional(Schema.Number),
  /** thresholdHitCount / thresholdDenominator as a percentage, null when the denominator is 0. */
  thresholdHitRatePercent: Schema.optional(Schema.NullOr(Schema.Number)),
  /**
   * Recorded verbatim from the recipe when true: the threshold was chosen
   * AFTER seeing the study's results, which makes any hit rate in-sample
   * exploration rather than a pre-registered expectation. Never inferred,
   * never defaulted.
   */
  thresholdChosenAfterResults: Schema.optional(Schema.Boolean),
  /** Null when the served window is shorter than the horizon. */
  baseline: Schema.NullOr(EventStudyBaseline),
  rows: Schema.Array(EventStudyRow),
  /** Coverage first, numbers second, and never a claim of significance. */
  verdict: Schema.String,
});
export type EventStudyReport = typeof EventStudyReport.Type;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const medianOf = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * Whether a study can run, and what to say when it cannot. `null` to run.
 *
 * The horizon cap lives here rather than in `runEventStudy` so the caller can
 * refuse before loading a bar, the same ordering the backtest budget uses.
 */
export function checkEventStudy(input: { readonly horizonBars: number }): string | null {
  if (
    !Number.isInteger(input.horizonBars) ||
    input.horizonBars < 1 ||
    input.horizonBars > EVENT_STUDY_MAX_HORIZON_BARS
  ) {
    return `horizonBars is a whole number of bars from 1 to ${EVENT_STUDY_MAX_HORIZON_BARS}`;
  }
  return null;
}

/**
 * The extremum of `priceField` over bars `fromIndex..toIndex` inclusive, with
 * the bar holding it. Null when the range holds no bar. Ties keep the EARLIEST
 * bar: the first time the path reached its extreme is the honest answer to
 * "when was the lowest point".
 */
function extremumOver(
  candles: ReadonlyArray<MarketCandle>,
  fromIndex: number,
  toIndex: number,
  priceField: EventStudyPriceField,
): { readonly openTime: number; readonly price: number } | null {
  let bestTime: number | undefined;
  let bestPrice = 0;
  for (let index = fromIndex; index <= toIndex; index += 1) {
    const bar = candles[index];
    if (bar === undefined) continue;
    const price = priceField === "low" ? bar.low : bar.high;
    if (bestTime === undefined || (priceField === "low" ? price < bestPrice : price > bestPrice)) {
      bestTime = bar.openTime;
      bestPrice = price;
    }
  }
  return bestTime === undefined ? null : { openTime: bestTime, price: bestPrice };
}

/**
 * The first grid slot whose close time is strictly after `endAt`.
 *
 * The archive stamps a bar's close as its LAST millisecond (open + interval −
 * 1, Hyperliquid's own `T` column carried through unchanged), so the first
 * close strictly after an instant normally belongs to the slot `endAt` falls
 * inside — except when `endAt` is itself a bar's closing millisecond, where
 * the strictly greater close belongs to the NEXT slot. Every close-basis
 * boundary here derives from that convention, and the equality cases (an end
 * exactly at a bar's open, exactly at its close, mid-bar) are pinned by tests
 * so the arithmetic cannot drift from the stamps it serves.
 */
function firstCloseAfterSlot(endAt: number, intervalMs: number): number {
  return Math.floor((endAt + 1) / intervalMs) * intervalMs;
}

/** The first grid slot at or after `endAt`: the open basis's entry slot. */
function firstOpenAtOrAfterSlot(endAt: number, intervalMs: number): number {
  return Math.ceil(endAt / intervalMs) * intervalMs;
}

/**
 * Length of the contiguous grid run starting at each bar: how many bars from
 * that index onward each sit exactly one interval after the one before. A
 * horizon is a span of INTERVALS, not a row count — with an interior gap, the
 * bar N rows later is more than N intervals later, and a "thirty-day" claim
 * made over such rows would silently stretch. Exit search, extrema, and
 * baseline samples all walk these runs and never bridge a gap with rows from
 * beyond it.
 */
function contiguousRunLengths(
  candles: ReadonlyArray<MarketCandle>,
  intervalMs: number,
): Array<number> {
  const runs = new Array<number>(candles.length).fill(1);
  for (let index = candles.length - 2; index >= 0; index -= 1) {
    const bar = candles[index];
    const next = candles[index + 1];
    if (bar !== undefined && next !== undefined && next.openTime - bar.openTime === intervalMs) {
      runs[index] = (runs[index + 1] as number) + 1;
    }
  }
  return runs;
}

/**
 * The descriptive claim, measured directly.
 *
 * Per occurrence, on the open basis: entry is the open of the first candle
 * whose open time is at or after `endAt`, exit is the close `horizonBars - 1`
 * bar intervals later. On the close basis: entry is the close of the first
 * candle whose close time is strictly after `endAt` (a bar containing an
 * intrabar activation closes after the activation), exit is the close a full
 * `horizonBars` bar intervals later. Occurrences the archive cannot see (they
 * predate it, have not happened yet, or sit behind a recording gap) are
 * reported as uncovered with their reason, never silently dropped: a mean
 * computed over the survivors of a silent filter is the most misleading
 * number this module could produce.
 *
 * Four rules keep the numbers honest, and each is a defect this engine used
 * to carry:
 *
 * - **Expected slots, not nearest rows.** The entry bar is identified by grid
 *   arithmetic from the archive's close-stamp convention. When the bar
 *   occupying that slot is absent, the row is uncovered ("a recording gap
 *   covers…"), never shifted to a later candle: a missing entry candle is
 *   missing data, not permission to measure from somewhere else.
 * - **Intervals, not row counts.** The horizon runs over a contiguous grid
 *   run. An interior gap truncates the row at the gap — `truncated` with a
 *   `truncationReason` naming it — rather than letting later rows stretch a
 *   nominal thirty days into more.
 * - **One as-of cutoff.** `now`, when provided, is the single line nothing
 *   forming may cross: candles whose close time is still in the future are
 *   excluded before any measurement, so no entry, exit, extremum or baseline
 *   sample can read a mutable provisional price. (Forming bars stay in the
 *   archive for the live chart; they only stop existing here.)
 * - **Complete horizons carry the aggregates.** Partial rows keep their
 *   measured numbers for inspection but are excluded from the mean, median,
 *   hit rate, best/worst, extrema aggregates, and the baseline comparison,
 *   which itself only samples complete, unbroken windows on the same entry
 *   convention and cutoff. `nComplete`/`nPartial`/`nUnavailable` give every
 *   surface the same unambiguous denominators.
 *
 * With `metric: "path_extrema"` every covered row additionally carries the
 * path extremum after entry within the measured window — the minimum low for
 * a short, the maximum high for a long — as `extremumTime`, `extremumPrice`
 * and `excursionReturnPct` (long convention, like `returnPct`). On the close
 * basis the extremum range starts AFTER the entry bar: the entry price is
 * that bar's close, a price that existed only once the bar had elapsed, so
 * the bar's own wick printed before the entry and cannot be a post-entry
 * extreme. On the open basis the entry bar counts, its open being the entry.
 * No USD figure is computed here: notional arithmetic is presentation-layer,
 * gross by construction, and never part of the report.
 *
 * `candles` is oldest first; duplicated or out-of-order rows are normalized
 * (sorted, duplicate open slots dropped) because they are storage artifacts,
 * not market data — but no candle is ever fabricated to fill a gap. Assumes
 * `checkEventStudy` passed. `entryBasis` defaults to the open basis so
 * pre-existing pure callers keep their behavior; the tool boundary resolves
 * the default explicitly. The metric defaults to forward_return; a
 * path_extrema call with no direction is treated as a short on the low (the
 * tool boundary refuses that call before it reaches here, so the pure engine
 * stays total).
 */
export function runEventStudy(input: {
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly intervalMs: number;
  readonly horizonBars: number;
  readonly entryBasis?: EventStudyEntryBasis;
  readonly metric?: EventStudyMetric;
  /** Read when metric is path_extrema; defaults to a short. */
  readonly direction?: EventStudyDirection;
  /** Read when metric is path_extrema; defaults to the direction's own field. */
  readonly priceField?: EventStudyPriceField;
  /**
   * Read when metric is path_extrema: an explicitly recorded excursion
   * threshold, long convention. Without one the study reports each row's
   * excursion (the distribution) and NO hit count — "massive" is a number the
   * caller names, never one the engine picks. With one, hits are counted over
   * complete rows only and the threshold rides the report verbatim.
   */
  readonly excursionThresholdPct?: number;
  /** Recorded verbatim on the report when true (see the schema field). */
  readonly thresholdChosenAfterResults?: boolean;
  readonly now?: number;
}): EventStudyReport {
  const { occurrences, intervalMs, horizonBars } = input;
  const basis = input.entryBasis ?? "first_bar_open_after_event";
  const metric = input.metric ?? EVENT_STUDY_DEFAULT_METRIC;
  const direction = input.direction ?? "short";
  const priceField = input.priceField ?? (direction === "short" ? "low" : "high");

  // One normalization, then one cutoff, before anything is measured. A
  // duplicated open slot is a write artifact, not two bars: the first row
  // wins. `now`, when provided, is what "closed" means — a bar whose close is
  // still in the future is forming, and nothing below may read it.
  const sorted = [...input.candles].sort((a, b) => a.openTime - b.openTime);
  const deduped: Array<MarketCandle> = [];
  for (const candle of sorted) {
    const previous = deduped[deduped.length - 1];
    if (previous !== undefined && previous.openTime === candle.openTime) continue;
    deduped.push(candle);
  }
  const candles =
    input.now === undefined
      ? deduped
      : deduped.filter((candle) => candle.closeTime <= (input.now as number));
  const runs = contiguousRunLengths(candles, intervalMs);

  const rows: Array<EventStudyRow> = [];
  // Long-convention returns and extrema of COMPLETE rows, unrounded: the
  // aggregates come from measured values, not display-rounded rows, and never
  // from partial windows.
  const rawReturns: Array<number> = [];
  const rawExtremes: Array<{ readonly excursion: number; readonly terminal: number }> = [];
  let nComplete = 0;
  let nPartial = 0;
  // Hits against the recorded threshold, counted only where the excursion and
  // the terminal return were both complete. `met` shares the excursion's own
  // sign convention: a short's dip threshold is negative and met at or below,
  // a long's spike threshold positive and met at or above.
  const threshold = input.excursionThresholdPct;
  const thresholdMet = (excursion: number): boolean =>
    threshold === undefined
      ? false
      : threshold < 0
        ? excursion <= threshold
        : excursion >= threshold;
  let thresholdHits = 0;

  const firstOpen = candles[0]?.openTime;
  const lastBar = candles.length === 0 ? undefined : candles[candles.length - 1];

  const uncovered = (
    base: Omit<
      EventStudyRow,
      | "covered"
      | "reason"
      | "entryTime"
      | "entryPrice"
      | "exitTime"
      | "exitPrice"
      | "returnPct"
      | "extremumTime"
      | "extremumPrice"
      | "excursionReturnPct"
      | "truncated"
      | "truncationReason"
      | "barsCovered"
    >,
    reason: string,
  ): EventStudyRow => ({
    ...base,
    covered: false,
    reason,
    entryTime: undefined,
    entryPrice: undefined,
    exitTime: undefined,
    exitPrice: undefined,
    returnPct: undefined,
    extremumTime: undefined,
    extremumPrice: undefined,
    excursionReturnPct: undefined,
    truncated: false,
    truncationReason: undefined,
    barsCovered: undefined,
  });

  for (const occurrence of occurrences) {
    const base = {
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
      ...(occurrence.timePrecision === undefined
        ? {}
        : { timePrecision: occurrence.timePrecision }),
      ...(occurrence.label === undefined ? {} : { label: occurrence.label }),
      source: occurrence.source,
    };
    if (firstOpen === undefined || lastBar === undefined) {
      rows.push(
        uncovered(
          base,
          "the archive holds no bars for this market, so there is nothing to measure against",
        ),
      );
      continue;
    }
    if (occurrence.endAt < firstOpen) {
      rows.push(
        uncovered(
          base,
          "before the archived window: the bar it would have entered on is not recorded",
        ),
      );
      continue;
    }

    if (basis === "first_closed_bar_after_event") {
      // The first candle whose close is strictly after the end. Binary search
      // on closeTime, the same shape the open basis uses on openTime.
      let lo = 0;
      let hi = candles.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((candles[mid]?.closeTime as number) > occurrence.endAt) hi = mid;
        else lo = mid + 1;
      }
      const entryIndex = lo;
      const entryBar = candles[entryIndex];
      if (entryBar === undefined || !(entryBar.close > 0)) {
        // No archived close sits after the end. Either the event is genuinely
        // in the future, or it ended at or after the last closed bar's close
        // and the bar that would carry the first post-event close is still
        // forming — the row says which, and reads no provisional price.
        rows.push(
          uncovered(
            base,
            input.now !== undefined && occurrence.endAt <= input.now
              ? "the first bar after this event has not closed yet, so there is no closed price to enter on"
              : "still in the future: it ends after the last archived bar",
          ),
        );
        continue;
      }
      // The entry bar is a specific grid slot. When the slot's bar is absent
      // the search lands on a later candle, and entering there would silently
      // shift the declared entry — the row refuses instead.
      const expectedEntryOpen = firstCloseAfterSlot(occurrence.endAt, intervalMs);
      if (entryBar.openTime !== expectedEntryOpen) {
        const missingBars = Math.round((entryBar.openTime - expectedEntryOpen) / intervalMs);
        rows.push(
          uncovered(
            base,
            `a recording gap covers the ${missingBars} bar(s) right after this event ended, ` +
              "so the close its entry would have measured from is not archived",
          ),
        );
        continue;
      }
      const runLength = runs[entryIndex] ?? 1;
      const available = runLength - 1;
      // Not one close-to-close interval exists: a zero-interval "return" of
      // 0% would be the most misleading number a covered row could carry.
      if (available < 1) {
        const nextPresent = candles[entryIndex + 1];
        const missingBars =
          nextPresent === undefined
            ? 0
            : Math.round((nextPresent.openTime - (entryBar.openTime + intervalMs)) / intervalMs) +
              1;
        rows.push(
          uncovered(
            base,
            nextPresent === undefined
              ? "the archive holds no bar after this event's entry bar yet, so not one close-to-close interval could be measured"
              : `a recording gap covers the ${missingBars} bar(s) right after this event ended, so not one close-to-close interval could be measured`,
          ),
        );
        continue;
      }
      // The exit is `horizonBars` INTERVALS of contiguous grid after the
      // entry bar; the run stops at whichever runs out first — the horizon,
      // a gap, or the data's edge.
      const exitOffset = horizonBars;
      const exitIndex = entryIndex + Math.min(exitOffset, available);
      const exitBar = candles[exitIndex] as MarketCandle;
      const truncated = available < exitOffset;
      const truncationReason =
        entryIndex + runLength === candles.length
          ? "the archived data ends before the horizon does"
          : "an internal recording gap ends the measured grid before the horizon does";
      const returnPct = ((exitBar.close - entryBar.close) / entryBar.close) * 100;
      // The extremum starts AFTER the entry bar: the entry price is that
      // bar's close, so the bar's own wick elapsed before the entry existed.
      const extremum =
        metric === "path_extrema"
          ? extremumOver(candles, entryIndex + 1, exitIndex, priceField)
          : null;
      const excursionPct =
        extremum === null ? null : ((extremum.price - entryBar.close) / entryBar.close) * 100;
      if (truncated) {
        nPartial += 1;
      } else {
        nComplete += 1;
        rawReturns.push(returnPct);
        if (extremum !== null && excursionPct !== null) {
          rawExtremes.push({ excursion: excursionPct, terminal: returnPct });
          if (threshold !== undefined && thresholdMet(excursionPct)) thresholdHits += 1;
        }
      }
      rows.push({
        ...base,
        covered: true,
        reason: undefined,
        entryTime: entryBar.closeTime,
        entryPrice: entryBar.close,
        exitTime: exitBar.closeTime,
        exitPrice: exitBar.close,
        returnPct: round2(returnPct),
        ...(extremum === null || excursionPct === null
          ? {}
          : {
              extremumTime: extremum.openTime,
              extremumPrice: extremum.price,
              excursionReturnPct: round2(excursionPct),
            }),
        truncated,
        ...(truncated ? { truncationReason } : {}),
        barsCovered: exitIndex - entryIndex,
      });
      continue;
    }

    // The first bar at or after the end. Binary search: the window can be
    // thousands of bars and the occurrences are few, but the shape is the same
    // one the funding lookup uses.
    if (occurrence.endAt > lastBar.openTime) {
      rows.push(
        uncovered(
          base,
          input.now !== undefined && occurrence.endAt <= input.now
            ? "the first bar at or after this event has not closed yet, so there is no final close to measure from"
            : "still in the future: it ends after the last archived bar",
        ),
      );
      continue;
    }
    let lo = 0;
    let hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((candles[mid]?.openTime as number) >= occurrence.endAt) hi = mid;
      else lo = mid + 1;
    }
    const entryIndex = lo;
    const entryBar = candles[entryIndex];
    if (entryBar === undefined || !(entryBar.open > 0)) {
      rows.push(uncovered(base, "the archived window holds no bar at or after the event ended"));
      continue;
    }
    // Same rule as the close basis: the entry is a specific grid slot, and a
    // absent slot bar is a recording gap, not a nudge to the next candle.
    const expectedEntryOpen = firstOpenAtOrAfterSlot(occurrence.endAt, intervalMs);
    if (entryBar.openTime !== expectedEntryOpen) {
      const missingBars = Math.round((entryBar.openTime - expectedEntryOpen) / intervalMs);
      rows.push(
        uncovered(
          base,
          `a recording gap covers the ${missingBars} bar(s) right after this event ended, ` +
            "so the bar its entry would have measured from is not archived",
        ),
      );
      continue;
    }
    const runLength = runs[entryIndex] ?? 1;
    const available = runLength - 1;
    const exitOffset = horizonBars - 1;
    const exitIndex = entryIndex + Math.min(exitOffset, available);
    const exitBar = candles[exitIndex];
    if (exitBar === undefined) {
      rows.push(uncovered(base, "the archived window holds no bar at or after the event ended"));
      continue;
    }
    const truncated = available < exitOffset;
    const truncationReason =
      entryIndex + runLength === candles.length
        ? "the archived data ends before the horizon does"
        : "an internal recording gap ends the measured grid before the horizon does";
    const returnPct = ((exitBar.close - entryBar.open) / entryBar.open) * 100;
    // The entry bar counts here: the entry is its OPEN, so the rest of that
    // bar — including its own wick — happened after the entry.
    const extremum =
      metric === "path_extrema" ? extremumOver(candles, entryIndex, exitIndex, priceField) : null;
    const excursionPct =
      extremum === null ? null : ((extremum.price - entryBar.open) / entryBar.open) * 100;
    if (truncated) {
      nPartial += 1;
    } else {
      nComplete += 1;
      rawReturns.push(returnPct);
      if (extremum !== null && excursionPct !== null) {
        rawExtremes.push({ excursion: excursionPct, terminal: returnPct });
        if (threshold !== undefined && thresholdMet(excursionPct)) thresholdHits += 1;
      }
    }
    rows.push({
      ...base,
      covered: true,
      reason: undefined,
      entryTime: entryBar.openTime,
      entryPrice: entryBar.open,
      exitTime: exitBar.closeTime,
      exitPrice: exitBar.close,
      returnPct: round2(returnPct),
      ...(extremum === null || excursionPct === null
        ? {}
        : {
            extremumTime: extremum.openTime,
            extremumPrice: extremum.price,
            excursionReturnPct: round2(excursionPct),
          }),
      truncated,
      ...(truncated ? { truncationReason } : {}),
      barsCovered: exitIndex - entryIndex + 1,
    });
  }

  const covered = rows.filter((row) => row.covered);
  // Aggregates from the measured values of COMPLETE rows, not the
  // display-rounded rows and never the partial ones. Early rounding can move
  // the reported center by a basis point on a small set; a partial row can
  // move it by a whole regime.
  const returns = rawReturns;
  const mean =
    returns.length === 0 ? null : returns.reduce((sum, value) => sum + value, 0) / returns.length;

  // Sampled at every bar holding a complete, unbroken horizon window, on the
  // same basis, cutoff and continuity policy the occurrences were measured
  // with: open-to-close over the horizon's bars on the open basis,
  // close-to-close a horizon of intervals apart on the close basis. Rolling
  // windows overlap, so consecutive samples share bars and the baseline
  // understates the variance of a single horizon-length return; it is a
  // center-of-mass comparison, not a significance test, and is never spoken
  // of as one.
  const samples: Array<number> = [];
  const exitOffset = basis === "first_closed_bar_after_event" ? horizonBars : horizonBars - 1;
  // A threshold on the rows demands a MATCHED comparison on the baseline: the
  // share of the same windows whose own post-entry excursion met the same
  // threshold, measured with the rows' own extremum range and entry price.
  // Without this, a dip frequency would be read against terminal returns —
  // a different question wearing the baseline's name.
  let baselineThresholdHits = 0;
  let baselineThresholdWindows = 0;
  for (let index = 0; index < candles.length; index += 1) {
    if ((runs[index] ?? 1) - 1 < exitOffset) continue;
    const entryBar = candles[index];
    const exitBar = candles[index + exitOffset];
    if (entryBar === undefined || exitBar === undefined) continue;
    if (basis === "first_closed_bar_after_event") {
      if (!(entryBar.close > 0)) continue;
      samples.push(((exitBar.close - entryBar.close) / entryBar.close) * 100);
      if (threshold !== undefined && metric === "path_extrema") {
        const extremum = extremumOver(candles, index + 1, index + exitOffset, priceField);
        if (extremum !== null) {
          baselineThresholdWindows += 1;
          if (thresholdMet(((extremum.price - entryBar.close) / entryBar.close) * 100)) {
            baselineThresholdHits += 1;
          }
        }
      }
    } else {
      if (!(entryBar.open > 0)) continue;
      samples.push(((exitBar.close - entryBar.open) / entryBar.open) * 100);
      if (threshold !== undefined && metric === "path_extrema") {
        const extremum = extremumOver(candles, index, index + exitOffset, priceField);
        if (extremum !== null) {
          baselineThresholdWindows += 1;
          if (thresholdMet(((extremum.price - entryBar.open) / entryBar.open) * 100)) {
            baselineThresholdHits += 1;
          }
        }
      }
    }
  }
  const baseline =
    samples.length === 0
      ? null
      : {
          samples: samples.length,
          meanReturnPct: round2(samples.reduce((sum, value) => sum + value, 0) / samples.length),
          medianReturnPct: round2(medianOf(samples)),
          ...(threshold !== undefined && metric === "path_extrema"
            ? {
                excursionThresholdHitRatePercent:
                  baselineThresholdWindows === 0
                    ? null
                    : round2((baselineThresholdHits / baselineThresholdWindows) * 100),
              }
            : {}),
        };

  const n = rows.length;
  const nCovered = covered.length;
  const hitRatePercent =
    returns.length === 0
      ? null
      : round2((returns.filter((value) => value > 0).length / returns.length) * 100);
  // The path_extrema aggregates: minimal and honest, and over complete rows
  // only. The mean excursion is long-convention like the rows, and the
  // beyond-terminal share says how often the path ran further than it ended —
  // both descriptions of what happened, never a realizable return.
  const extremaAggregate =
    metric === "path_extrema"
      ? {
          metric,
          meanExcursionPct:
            rawExtremes.length === 0
              ? null
              : round2(
                  rawExtremes.reduce((sum, pair) => sum + pair.excursion, 0) / rawExtremes.length,
                ),
          excursionBeyondTerminalPercent:
            rawExtremes.length === 0
              ? null
              : round2(
                  (rawExtremes.filter((pair) => Math.abs(pair.excursion) > Math.abs(pair.terminal))
                    .length /
                    rawExtremes.length) *
                    100,
                ),
        }
      : {};
  // The threshold block, when the recipe recorded one: the number verbatim,
  // the count, the denominator, the rate, and whether the number was picked
  // after the results were already visible. All of it or none of it — a hit
  // rate without its threshold or its denominator is the inadmissible number.
  const thresholdAggregate =
    threshold !== undefined && metric === "path_extrema"
      ? {
          excursionThresholdPct: threshold,
          thresholdHitCount: thresholdHits,
          thresholdDenominator: nComplete,
          thresholdHitRatePercent:
            nComplete === 0 ? null : round2((thresholdHits / nComplete) * 100),
          ...(input.thresholdChosenAfterResults === true
            ? { thresholdChosenAfterResults: true as const }
            : {}),
        }
      : {};
  const verdict = composeVerdict({
    n,
    nCovered,
    nComplete,
    mean,
    horizonBars,
    baseline,
    ...(threshold !== undefined && metric === "path_extrema"
      ? {
          threshold: {
            pct: threshold,
            hits: thresholdHits,
            denominator: nComplete,
          },
        }
      : {}),
  });

  return {
    ...extremaAggregate,
    ...thresholdAggregate,
    horizonBars,
    horizonMs: horizonBars * intervalMs,
    n,
    nCovered,
    nComplete,
    nPartial,
    nUnavailable: n - nCovered,
    meanReturnPct: mean === null ? null : round2(mean),
    medianReturnPct: returns.length === 0 ? null : round2(medianOf(returns)),
    hitRatePercent,
    bestReturnPct: returns.length === 0 ? null : round2(Math.max(...returns)),
    worstReturnPct: returns.length === 0 ? null : round2(Math.min(...returns)),
    baseline,
    rows,
    verdict,
  };
}

/**
 * The one sentence that travels with the numbers.
 *
 * Coverage comes first because it is the thing the reader has to know before
 * any mean means anything, and completeness second for the same reason: a
 * mean over complete horizons beside truncated rows is only honest when the
 * sentence says which rows carry it. The closing clause is fixed: a handful
 * of occurrences measured over one window is a description of what happened,
 * and the sentence must never drift into sounding like evidence.
 */
function composeVerdict(input: {
  readonly n: number;
  readonly nCovered: number;
  readonly nComplete: number;
  readonly mean: number | null;
  readonly horizonBars: number;
  readonly baseline: EventStudyBaseline | null;
  readonly threshold?: {
    readonly pct: number;
    readonly hits: number;
    readonly denominator: number;
  };
}): string {
  const noun = input.n === 1 ? "occurrence" : "occurrences";
  const verb = input.n === 1 ? "falls" : "fall";
  const coverage = `${input.nCovered} of ${input.n} ${noun} ${verb} inside archived data`;
  const honesty =
    "This describes what happened after those dates; it is not evidence the pattern repeats.";
  if (input.n === 0) {
    return `The set holds no occurrences yet, so there is nothing to study. ${honesty}`;
  }
  if (input.nCovered === 0) {
    return `${coverage}, so there is nothing to measure. ${honesty}`;
  }
  const completeClause =
    input.nComplete === input.nCovered
      ? ""
      : `; ${input.nComplete} of those completed the full ${input.horizonBars}-bar horizon, and every aggregate here is over complete horizons only`;
  if (input.mean === null) {
    return `${coverage}${completeClause}, so no full-horizon return exists to aggregate. ${honesty}`;
  }
  const against =
    input.baseline === null
      ? ""
      : `, against a baseline of ${input.baseline.meanReturnPct}% over the same horizon sampled at every archived bar`;
  // The threshold sentence states its own denominator and its own comparison;
  // "3 of 5" must never compress into a bare percentage, and a threshold
  // picked after the results says so inside the sentence itself.
  const thresholdSentence =
    input.threshold === undefined
      ? ""
      : ` The recorded ${input.threshold.pct}% excursion threshold was met by ${input.threshold.hits} of ${input.threshold.denominator} complete horizons` +
        (input.baseline?.excursionThresholdHitRatePercent == null
          ? ""
          : `, against ${input.baseline.excursionThresholdHitRatePercent}% of the same every-bar windows`);
  return `${coverage}${completeClause}. Mean forward return ${round2(input.mean)}% over ${input.horizonBars} bars${against}.${thresholdSentence} ${honesty}`;
}

// ---------------------------------------------------------------------------
// the tool surface
// ---------------------------------------------------------------------------

/** One set as `list` shows it. */
export const TradingEventSetSummary = Schema.Struct({
  eventSetId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  occurrenceCount: Schema.Number,
  /** The next occurrence that has not ended yet, when there is one. */
  nextUpcomingEndAt: Schema.NullOr(UnixMillis),
  updatedAt: UnixMillis,
});
export type TradingEventSetSummary = typeof TradingEventSetSummary.Type;

export const TRADING_EVENTS_TOOL = "trading_events";

export const TradingEventsAction = Schema.Literals([
  "preview",
  "record",
  "add",
  "list",
  "show",
  "study",
  "retire",
]);
export type TradingEventsAction = typeof TradingEventsAction.Type;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Whether an ISO string names whole days only (YYYY-MM-DD), no time of day. */
const isDateOnly = (text: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(text.trim());

/**
 * One occurrence as the tool takes it: ISO strings, per the wire contract.
 *
 * A date-only `start`/`end` pair is DATE precision: whole UTC days, with a
 * date-only `end` meaning that day too (a multi-day conference is ONE
 * occurrence spanning through its last day) and a missing `end` meaning the
 * start day alone.
 *
 * A timed `start` is an exact instant and refuses to guess anything: it needs
 * a timed `end` of its own — the same instant for an instantaneous activation
 * (a protocol upgrade switching on), a later one for a window — because the
 * old behavior of padding a lone timed start to a day it did not span wrote
 * spans the research never established.
 *
 * `precision` declares which of those the caller means. It is optional
 * (the shapes above decide), and a declaration the shapes contradict is a
 * refusal rather than a silent reinterpretation.
 */
export const TradingEventsOccurrenceInput = Schema.Struct({
  start: Schema.String,
  end: Schema.optional(Schema.String),
  precision: Schema.optional(TradingEventTimePrecision),
  label: Schema.optional(Schema.String),
  source: Schema.String,
});
export type TradingEventsOccurrenceInput = typeof TradingEventsOccurrenceInput.Type;

/** The instant an ISO string names, treating a date-only string as UTC midnight. */
const parseInstant = (text: string): number | null => {
  const iso = isDateOnly(text) ? `${text.trim()}T00:00:00Z` : text.trim();
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Tool input to domain occurrence, or the refusal naming which one broke.
 *
 * Pure, and the only place the ISO conventions live: every caller that reads
 * tool input goes through here, so "date-only means whole UTC days" means one
 * thing rather than one thing per caller. The three precision kinds:
 *
 * - date-only start → `date`: startAt is that day's 00:00 UTC, endAt is the
 *   exclusive next midnight of the date-only `end` when there is one,
 *   otherwise of the start day itself.
 * - timed start + timed end → `instant` when equal, `window` when the end is
 *   later. A timed start with no end REFUSES rather than inventing a day, and
 *   a date-only end beside a timed start refuses as ambiguous; the mixed
 *   date-only/timed pairing likewise refuses in the other direction.
 * - a declared `precision` the shapes contradict refuses, naming the fix.
 */
export function parseTradingEventsOccurrence(
  input: TradingEventsOccurrenceInput,
): { readonly occurrence: TradingEventOccurrence } | { readonly reason: string } {
  const startIsDateOnly = isDateOnly(input.start);
  if (startIsDateOnly && (input.precision === "instant" || input.precision === "window")) {
    return {
      reason:
        "a date-only start cannot claim an exact instant — record the timed activation instant, or keep date precision",
    };
  }
  if (!startIsDateOnly && input.precision === "date") {
    return { reason: "a timed instant cannot claim date precision" };
  }

  const startAt = parseInstant(input.start);
  if (startAt === null) {
    return { reason: `start "${input.start}" is not an ISO date` };
  }

  if (startIsDateOnly) {
    let endAt: number;
    if (input.end === undefined) {
      // The start day's exclusive midnight: the whole day, whatever time it began.
      endAt = startAt + DAY_MS;
    } else {
      if (!isDateOnly(input.end)) {
        return {
          reason:
            "end must be a date-only date when start is date-only; a timed end pairs with a timed start",
        };
      }
      const parsedEnd = parseInstant(input.end);
      if (parsedEnd === null) {
        return { reason: `end "${input.end}" is not an ISO date` };
      }
      // The end day's exclusive midnight, so "after Devcon" stays after the
      // LAST day of a multi-day date range recorded as one occurrence.
      endAt = parsedEnd + DAY_MS;
    }
    return {
      occurrence: {
        startAt,
        endAt,
        timePrecision: "date",
        ...(input.label === undefined ? {} : { label: input.label }),
        source: input.source,
      },
    };
  }

  // A timed start is an exact claim, so it refuses to invent anything: no
  // fabricated day for a missing end, no ambiguous date-only end.
  if (input.end === undefined) {
    return {
      reason:
        "a timed start with no end cannot invent a duration — give the end instant, or use a date-only start for date precision",
    };
  }
  if (isDateOnly(input.end)) {
    return {
      reason:
        "end must be a timed instant when start is timed; a date-only end pairs with a date-only start",
    };
  }
  const endAt = parseInstant(input.end);
  if (endAt === null) {
    return { reason: `end "${input.end}" is not an ISO date` };
  }
  const shape: TradingEventTimePrecision = endAt === startAt ? "instant" : "window";
  if (input.precision !== undefined && input.precision !== shape) {
    return {
      reason:
        input.precision === "instant"
          ? 'declared precision "instant" does not match the span: start and end are different instants'
          : 'declared precision "window" does not match the span: start and end are the same instant',
    };
  }
  return {
    occurrence: {
      startAt,
      endAt,
      timePrecision: shape,
      ...(input.label === undefined ? {} : { label: input.label }),
      source: input.source,
    },
  };
}

export const TradingEventsInput = Schema.Struct({
  /** Attribution, never authority: an event set takes no mission state. */
  missionId: Schema.optional(Schema.String),
  action: Schema.optional(TradingEventsAction),
  /** Required by everything except `record`, `preview` and `list`. */
  eventSetId: Schema.optional(Schema.String),
  /** Required by `record`, and by `preview` when the preview is for a record. */
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Required by `record`, `add` and `preview`: the dated occurrences with their sources. */
  occurrences: Schema.optional(Schema.Array(TradingEventsOccurrenceInput)),
  /**
   * Requires the read-back protocol on `record`/`add`: the payload must match
   * the pending confirmation a `preview` persisted for this thread, by digest.
   */
  requireReadBack: Schema.optional(Schema.Boolean),
  /** The digest a `preview` returned; required when `requireReadBack` is true. */
  confirmationDigest: Schema.optional(Schema.String),
  /** Required by `study`: the market whose archived bars answer it. */
  market: Schema.optional(TradingMarket),
  interval: Schema.optional(BacktestInterval),
  /** Bars forward the study measures. Defaults to 30. */
  horizonBars: Schema.optional(Schema.Number),
  /**
   * How the study prices its entry. Defaults to
   * {@link EVENT_STUDY_DEFAULT_ENTRY_BASIS}; the menu spells both values out.
   */
  entryBasis: Schema.optional(EventStudyEntryBasis),
  /**
   * What the study measures besides the terminal close return. Defaults to
   * {@link EVENT_STUDY_DEFAULT_METRIC}; `direction` (required) and
   * `priceField` (optional, the direction's own by default) apply only to
   * path_extrema, and a contradictory pair is refused by
   * {@link resolveEventStudyMetric} before a bar is read.
   */
  metric: Schema.optional(EventStudyMetric),
  /** path_extrema only: the side whose favorable excursion is measured. */
  direction: Schema.optional(EventStudyDirection),
  /** path_extrema only: overrides the extremum price field (low for short, high for long). */
  priceField: Schema.optional(EventStudyPriceField),
  /**
   * path_extrema only: an explicitly recorded excursion threshold, in the
   * long convention (a short's dip threshold is negative). Without one the
   * study reports each occurrence's excursion and no hit rate — the caller
   * names what "massive" means, never the engine. With one, the report
   * carries the threshold verbatim, the hit count, the complete-horizon
   * denominator, and a matched every-bar baseline hit rate.
   */
  excursionThresholdPct: Schema.optional(Schema.Number),
  /**
   * Record `true` when the threshold was chosen after the study's results
   * were already visible: the hit rate is then in-sample exploration, and the
   * report says so rather than letting the number pass as pre-registered.
   */
  thresholdChosenAfterResults: Schema.optional(Schema.Boolean),
});
export type TradingEventsInput = typeof TradingEventsInput.Type;

export const TradingEventsResult = Schema.Struct({
  /** Set by `record`, `add`, `show` and `retire`. */
  eventSet: Schema.optional(TradingEventSet),
  /** Set by `list`. */
  eventSets: Schema.optional(Schema.Array(TradingEventSetSummary)),
  /** Set by `preview`: the ordered normalized occurrences it read back. */
  occurrences: Schema.optional(Schema.Array(TradingEventOccurrence)),
  /** Set by `preview`: the digest that confirms this exact payload. */
  confirmationDigest: Schema.optional(Schema.String),
  /** Set by `study`, with the composed honesty sentence in `verdict`. */
  study: Schema.optional(EventStudyReport),
  /** What the call did, in one sentence the model can relay. */
  outcome: Schema.optional(Schema.String),
  /** Why a call changed nothing. Present only on a refusal. */
  refused: Schema.optional(Schema.String),
  /** The vocabulary, when this call was the menu call. */
  menu: Schema.optional(Schema.String),
});
export type TradingEventsResult = typeof TradingEventsResult.Type;

/**
 * The canonical serialization a read-back confirmation digest is taken over.
 *
 * Pure, deterministic, and boring on purpose: a fixed-shape array (never an
 * object, whose key order a serializer could reorder) holding the version
 * tag, the thread the confirmation is scoped to, the action that will consume
 * it, the name it will record (`""` for `add`, which carries none), and the
 * occurrences IN ORDER — each as [startAt, endAt, timePrecision, label,
 * source], absent optionals as `""`. The server hashes this string; anything
 * that changes one field changes the string, which changes the digest.
 */
export function serializeEventConfirmationPayload(input: {
  readonly threadId: string;
  readonly action: "record" | "add";
  readonly name: string;
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
}): string {
  return JSON.stringify([
    "trading_events.readback.v1",
    input.threadId,
    input.action,
    input.name,
    input.occurrences.map((occurrence) => [
      occurrence.startAt,
      occurrence.endAt,
      occurrence.timePrecision ?? "",
      occurrence.label ?? "",
      occurrence.source,
    ]),
  ]);
}

/**
 * The canonical serialization an event set's CONTENT identity is taken over.
 *
 * A set's id is stable while its occurrences are corrected and amended, so an
 * id alone cannot say which dates a saved evaluation actually ran on. This is
 * the content half of the identity: the set's name and its occurrences in
 * order — each as [startAt, endAt, timePrecision, label, source] — under a
 * version tag, in the same fixed-shape style as
 * {@link serializeEventConfirmationPayload}. Hash it (the server uses
 * sha256 over the utf8 string) and a hypothesis, validation or scene that
 * referenced the set can pin what it saw: a later calendar edit changes the
 * digest, which is exactly the moment a saved run must say "the calendar
 * changed since this was computed" instead of silently meaning something
 * else.
 */
export function serializeEventSetContent(set: {
  readonly name: string;
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
}): string {
  return JSON.stringify([
    "trading_events.content.v1",
    set.name,
    set.occurrences.map((occurrence) => [
      occurrence.startAt,
      occurrence.endAt,
      occurrence.timePrecision ?? "",
      occurrence.label ?? "",
      occurrence.source,
    ]),
  ]);
}

/**
 * The vocabulary, served to the call that asked. Composed from the constants
 * that enforce it, the same discipline the backtest menu follows, so a cap
 * moved here changes the sentence without anybody remembering to.
 */
export function renderTradingEventsMenu(): string {
  return [
    "preview {name?, occurrences: [{start, end?, precision?, label?, source}]} reads them back with a confirmationDigest; a name previews a record, no name an add",
    "record {name, description?, occurrences} creates or replaces a set's dates (case-insensitive name, retired revives, re-recording corrects); add {eventSetId, occurrences} appends, show/retire {eventSetId}, list",
    "dates are UTC ISO: date-only start/end is date precision (whole days; a missing end spans the start day, a date-only end through that day); a timed start is exact and needs its timed end: same instant is an activation, later a window; a timed start with no end is refused, not padded; declared precision (instant/window/date) contradictions refuse",
    `one source per occurrence (the URL, or "user provided"), never several joined, ${EVENT_SET_MAX_OCCURRENCES} max a set; record/add take requireReadBack: true and the preview's confirmationDigest`,
    `study {eventSetId, market, interval?, horizonBars?, entryBasis?, metric?} measures per-occurrence forward return vs an every-bar baseline, entryBasis first_closed_bar_after_event (default), interval 1m 3m 5m 15m 1h 4h 1d: a four-week daily study is interval 1d, horizonBars 28; coarsest interval covering the window; metric path_extrema {direction} adds the post-entry extremum and excursion, hindsight-perfect; uncovered occurrences reported, not dropped`,
    `a hit rate needs a recorded excursionThresholdPct (negative for a short's dip, long convention): without one, present each occurrence's excursion and ask; with one, hits are counted over complete horizons against a matched every-bar baseline, and thresholdChosenAfterResults: true is recorded when the number was picked after seeing results`,
    `a lowest/highest-point exit is hindsight, never a rule: backtesting or validating an event idea needs a prospective exit (stop, target, or maxHoldBars)`,
    "theses anchor with operand {source: event, eventSetId, label}: bars since the most recent ended occurrence; profit simulation is trading_backtest's",
  ].join(" · ");
}
