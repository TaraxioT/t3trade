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
 */
export function resolveEventStudyMetric(input: {
  readonly metric?: EventStudyMetric | undefined;
  readonly direction?: EventStudyDirection | undefined;
  readonly priceField?: EventStudyPriceField | undefined;
}): ResolvedEventStudyMetric | { readonly reason: string } {
  const metric = input.metric ?? EVENT_STUDY_DEFAULT_METRIC;
  if (metric === "forward_return") {
    if (input.direction !== undefined || input.priceField !== undefined) {
      return {
        reason:
          "direction and priceField apply only to the path_extrema metric; drop them, or name metric: path_extrema",
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
   * bar holding the path extremum after the defined entry within the horizon
   * (the bars actually covered, when the window truncated). The open time, not
   * a moment inside the bar: the low printed somewhere in that bar, and the
   * row claims the bar, never a millisecond it cannot know.
   */
  extremumTime: Schema.optional(UnixMillis),
  /** Present with `extremumTime`: the extremum price (a short's lowest low, a long's highest high). */
  extremumPrice: Schema.optional(Schema.Number),
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
  /** Null when nothing was covered. Never guessed, never zero. */
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
 * The descriptive claim, measured directly.
 *
 * Per occurrence, on the open basis: entry is the open of the first candle
 * whose open time is at or after `endAt`, exit is the close `horizonBars - 1`
 * bars later. On the close basis: entry is the close of the first candle
 * whose close time is strictly after `endAt`, exit is the close a full
 * `horizonBars` bar intervals later, truncated at the last served close when
 * the window runs out first. Occurrences the archive cannot see (they
 * predate it, have not happened yet, or sit behind a recording gap) are
 * reported as uncovered with their reason, never silently dropped: a mean
 * computed over the survivors of a silent filter is the most misleading
 * number this module could produce.
 *
 * With `metric: "path_extrema"` every covered row additionally carries the
 * path extremum after the defined entry within the horizon — the minimum low
 * for a short, the maximum high for a long, over the bars actually measured
 * (a truncated window measures the bars it got) — as `extremumTime`,
 * `extremumPrice` and `excursionReturnPct` (long convention, like
 * `returnPct`). The terminal `returnPct` is computed separately and both stay
 * on the row. No USD figure is computed here: notional arithmetic is
 * presentation-layer, gross by construction, and never part of the report.
 *
 * `candles` is oldest first. Assumes `checkEventStudy` passed. `entryBasis`
 * defaults to the open basis so pre-existing pure callers keep their
 * behavior; the tool boundary resolves the default explicitly. `now`, when
 * provided, is what "closed" means: on the close basis a candidate entry bar
 * whose close time is still in the future has no close price to enter on,
 * and the row says so rather than reading a forming bar's provisional close.
 * The metric defaults to forward_return; a path_extrema call with no
 * direction is treated as a short on the low (the tool boundary refuses that
 * call before it reaches here, so the pure engine stays total).
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
  readonly now?: number;
}): EventStudyReport {
  const { occurrences, candles, intervalMs, horizonBars } = input;
  const basis = input.entryBasis ?? "first_bar_open_after_event";
  const metric = input.metric ?? EVENT_STUDY_DEFAULT_METRIC;
  const direction = input.direction ?? "short";
  const priceField = input.priceField ?? (direction === "short" ? "low" : "high");
  const rows: Array<EventStudyRow> = [];
  const rawReturns: Array<number> = [];
  // Long-convention excursion and terminal return per covered row, unrounded:
  // the aggregates come from measured values, not display-rounded rows.
  const rawExtremes: Array<{ readonly excursion: number; readonly terminal: number }> = [];

  const firstOpen = candles[0]?.openTime;
  const lastOpen = candles.length === 0 ? undefined : candles[candles.length - 1]?.openTime;

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
    if (firstOpen === undefined || lastOpen === undefined) {
      rows.push(
        uncovered(
          base,
          "the archive holds no bars for this market, so there is nothing to measure against",
        ),
      );
      continue;
    }
    // The open basis calls an occurrence future when it ends after the last
    // archived OPEN. The close basis cannot use that line: an activation
    // inside the newest bar has already happened, and the honest reason is
    // that its entry close has not formed yet, so its future test waits until
    // the search below finds no archived close after the event at all.
    if (basis === "first_bar_open_after_event" && occurrence.endAt > lastOpen) {
      rows.push(uncovered(base, "still in the future: it ends after the last archived bar"));
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
      const exitWanted = entryIndex + horizonBars;
      const exitIndex = Math.min(exitWanted, candles.length - 1);
      const entryBar = candles[entryIndex];
      const exitBar = candles[exitIndex];
      if (entryBar === undefined || !(entryBar.close > 0)) {
        rows.push(uncovered(base, "still in the future: it ends after the last archived bar"));
        continue;
      }
      // A recording gap would otherwise pass silently: the first close after
      // the end would sit whole intervals later, and measuring from it would
      // present a much later candle as the entry. The boundary mirrors the
      // open basis: a candidate at most one interval late (the event ended
      // inside the missing bar's slot) still measures, a full missing
      // interval or more refuses. When the entry bar is present its open is
      // never later than the event, so this fires only on genuinely absent
      // bars.
      const entryGapMs = entryBar.openTime - occurrence.endAt;
      if (entryGapMs >= intervalMs) {
        const missingBars = Math.floor(entryGapMs / intervalMs);
        rows.push(
          uncovered(
            base,
            `a recording gap covers the ${missingBars} bar(s) right after this event ended, ` +
              "so the close its entry would have measured from is not archived",
          ),
        );
        continue;
      }
      if (input.now !== undefined && entryBar.closeTime > input.now) {
        rows.push(
          uncovered(
            base,
            "the first bar after this event has not closed yet, so there is no closed price to enter on",
          ),
        );
        continue;
      }
      // Not one close-to-close interval exists: a zero-interval "return" of
      // 0% would be the most misleading number a covered row could carry.
      if (exitIndex <= entryIndex || exitBar === undefined) {
        rows.push(
          uncovered(
            base,
            "the archive holds no bar after this event's entry bar yet, so not one close-to-close interval could be measured",
          ),
        );
        continue;
      }
      const truncated = exitIndex < exitWanted;
      const returnPct = ((exitBar.close - entryBar.close) / entryBar.close) * 100;
      rawReturns.push(returnPct);
      // The extremum over the entry..exit bars actually served: when the
      // window truncated, the bars it got are what the path did.
      const extremum =
        metric === "path_extrema" ? extremumOver(candles, entryIndex, exitIndex, priceField) : null;
      const excursionPct =
        extremum === null ? null : ((extremum.price - entryBar.close) / entryBar.close) * 100;
      if (extremum !== null && excursionPct !== null) {
        rawExtremes.push({ excursion: excursionPct, terminal: returnPct });
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
        barsCovered: exitIndex - entryIndex,
      });
      continue;
    }

    // The first bar at or after the end. Binary search: the window can be
    // thousands of bars and the occurrences are few, but the shape is the same
    // one the funding lookup uses.
    let lo = 0;
    let hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((candles[mid]?.openTime as number) >= occurrence.endAt) hi = mid;
      else lo = mid + 1;
    }
    const entryIndex = lo;
    const exitWanted = entryIndex + horizonBars - 1;
    const exitIndex = Math.min(exitWanted, candles.length - 1);
    const entryBar = candles[entryIndex];
    const exitBar = candles[exitIndex];
    if (entryBar === undefined || exitBar === undefined || !(entryBar.open > 0)) {
      rows.push(uncovered(base, "the archived window holds no bar at or after the event ended"));
      continue;
    }
    // A recording gap across the event's end would otherwise pass silently:
    // the first bar at or after `endAt` would sit whole intervals later, and
    // measuring from it would present a much later candle as the event entry.
    // An occurrence whose entry region is missing is uncovered, the same as
    // one the window never held at all.
    //
    // A first bar exactly one interval after the event ended means the bar at
    // the event boundary is missing. Measuring from the next bar would shift
    // the declared entry silently, so the boundary is inclusive.
    const entryGapMs = entryBar.openTime - occurrence.endAt;
    if (entryGapMs >= intervalMs) {
      const missingBars = Math.floor(entryGapMs / intervalMs);
      rows.push(
        uncovered(
          base,
          `a recording gap covers the ${missingBars} bar(s) right after this event ended, ` +
            "so the bar its entry would have measured from is not archived",
        ),
      );
      continue;
    }
    const truncated = exitIndex < exitWanted;
    const returnPct = ((exitBar.close - entryBar.open) / entryBar.open) * 100;
    rawReturns.push(returnPct);
    // Same rule as the close basis: the extremum over the bars actually
    // measured, entry bar included — its low can sit below its own open.
    const extremum =
      metric === "path_extrema" ? extremumOver(candles, entryIndex, exitIndex, priceField) : null;
    const excursionPct =
      extremum === null ? null : ((extremum.price - entryBar.open) / entryBar.open) * 100;
    if (extremum !== null && excursionPct !== null) {
      rawExtremes.push({ excursion: excursionPct, terminal: returnPct });
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
      barsCovered: exitIndex - entryIndex + 1,
    });
  }

  const covered = rows.filter((row) => row.covered);
  // Aggregate from the measured values, not the display-rounded rows. Early
  // rounding can move the reported center by a basis point on a small set.
  const returns = rawReturns;
  const mean =
    returns.length === 0 ? null : returns.reduce((sum, value) => sum + value, 0) / returns.length;

  // Sampled at every bar the horizon fits behind, on the same basis the
  // occurrences were measured: open-to-close over the horizon's bars on the
  // open basis, close-to-close a horizon of intervals apart on the close
  // basis. Rolling windows overlap, so consecutive samples share bars and the
  // baseline understates the variance of a single horizon-length return; it
  // is a center-of-mass comparison, not a significance test, and is never
  // spoken of as one.
  const samples: Array<number> = [];
  const exitOffset = basis === "first_closed_bar_after_event" ? horizonBars : horizonBars - 1;
  for (let index = 0; index + exitOffset <= candles.length - 1; index += 1) {
    const entryBar = candles[index];
    const exitBar = candles[index + exitOffset];
    if (entryBar === undefined || exitBar === undefined) continue;
    if (basis === "first_closed_bar_after_event") {
      if (!(entryBar.close > 0)) continue;
      samples.push(((exitBar.close - entryBar.close) / entryBar.close) * 100);
    } else {
      if (!(entryBar.open > 0)) continue;
      samples.push(((exitBar.close - entryBar.open) / entryBar.open) * 100);
    }
  }
  const baseline =
    samples.length === 0
      ? null
      : {
          samples: samples.length,
          meanReturnPct: round2(samples.reduce((sum, value) => sum + value, 0) / samples.length),
          medianReturnPct: round2(medianOf(samples)),
        };

  const n = rows.length;
  const nCovered = covered.length;
  const hitRatePercent =
    returns.length === 0
      ? null
      : round2((returns.filter((value) => value > 0).length / returns.length) * 100);
  // The path_extrema aggregates: minimal and honest. The mean excursion is
  // long-convention like the rows, and the beyond-terminal share says how
  // often the path ran further than it ended — both descriptions of what
  // happened, never a realizable return.
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
  const verdict = composeVerdict({ n, nCovered, mean, horizonBars, baseline });

  return {
    ...extremaAggregate,
    horizonBars,
    horizonMs: horizonBars * intervalMs,
    n,
    nCovered,
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
 * any mean means anything, and the closing clause is fixed: a handful of
 * occurrences measured over one window is a description of what happened, and
 * the sentence must never drift into sounding like evidence.
 */
function composeVerdict(input: {
  readonly n: number;
  readonly nCovered: number;
  readonly mean: number | null;
  readonly horizonBars: number;
  readonly baseline: EventStudyBaseline | null;
}): string {
  const noun = input.n === 1 ? "occurrence" : "occurrences";
  const verb = input.n === 1 ? "falls" : "fall";
  const coverage = `${input.nCovered} of ${input.n} ${noun} ${verb} inside archived data`;
  const honesty =
    "This describes what happened after those dates; it is not evidence the pattern repeats.";
  if (input.n === 0) {
    return `The set holds no occurrences yet, so there is nothing to study. ${honesty}`;
  }
  if (input.nCovered === 0 || input.mean === null) {
    return `${coverage}, so there is nothing to measure. ${honesty}`;
  }
  const against =
    input.baseline === null
      ? ""
      : `, against a baseline of ${input.baseline.meanReturnPct}% over the same horizon sampled at every archived bar`;
  return `${coverage}. Mean forward return ${round2(input.mean)}% over ${input.horizonBars} bars${against}. ${honesty}`;
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
    "theses anchor with operand {source: event, eventSetId, label}: bars since the most recent ended occurrence; profit simulation is trading_backtest's",
  ].join(" · ");
}
