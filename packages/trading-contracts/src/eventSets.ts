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
 * One dated occurrence of the event, in UTC milliseconds.
 *
 * `startAt` and `endAt` make a multi-day event one occurrence rather than
 * several: a conference is the whole span, and "after Devcon" means after the
 * LAST day, which is why every consumer anchors on `endAt`.
 *
 * `source` is where the date came from: a URL the agent can cite back, or the
 * words "user provided" when the user dictated the date. Required and
 * non-empty, because an unsourced date is indistinguishable from an invented
 * one and everything downstream treats these rows as facts.
 */
export const TradingEventOccurrence = Schema.Struct({
  startAt: UnixMillis,
  endAt: UnixMillis,
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
 * `candles` is oldest first. Assumes `checkEventStudy` passed. `entryBasis`
 * defaults to the open basis so pre-existing pure callers keep their
 * behavior; the tool boundary resolves the default explicitly. `now`, when
 * provided, is what "closed" means: on the close basis a candidate entry bar
 * whose close time is still in the future has no close price to enter on,
 * and the row says so rather than reading a forming bar's provisional close.
 */
export function runEventStudy(input: {
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly intervalMs: number;
  readonly horizonBars: number;
  readonly entryBasis?: EventStudyEntryBasis;
  readonly now?: number;
}): EventStudyReport {
  const { occurrences, candles, intervalMs, horizonBars } = input;
  const basis = input.entryBasis ?? "first_bar_open_after_event";
  const rows: Array<EventStudyRow> = [];
  const rawReturns: Array<number> = [];

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
    truncated: false,
    barsCovered: undefined,
  });

  for (const occurrence of occurrences) {
    const base = {
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
      label: occurrence.label,
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
      rows.push({
        ...base,
        covered: true,
        reason: undefined,
        entryTime: entryBar.closeTime,
        entryPrice: entryBar.close,
        exitTime: exitBar.closeTime,
        exitPrice: exitBar.close,
        returnPct: round2(returnPct),
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
    rows.push({
      ...base,
      covered: true,
      reason: undefined,
      entryTime: entryBar.openTime,
      entryPrice: entryBar.open,
      exitTime: exitBar.closeTime,
      exitPrice: exitBar.close,
      returnPct: round2(returnPct),
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
  const verdict = composeVerdict({ n, nCovered, mean, horizonBars, baseline });

  return {
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
  "record",
  "add",
  "list",
  "show",
  "study",
  "retire",
]);
export type TradingEventsAction = typeof TradingEventsAction.Type;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * One occurrence as the tool takes it: ISO strings, per the wire contract.
 *
 * A date-only string means 00:00 UTC; a date-only `end` means the exclusive
 * next midnight; a missing `end` means the start day's exclusive midnight, so
 * "after Devcon" means after the LAST day and a multi-day event is one
 * occurrence, anchored on its end.
 *
 * An instantaneous event (a protocol upgrade activation) is the other honest
 * shape: record `start` and `end` as the SAME ISO instant, and the study
 * anchors on that exact moment.
 */
export const TradingEventsOccurrenceInput = Schema.Struct({
  start: Schema.String,
  end: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  source: Schema.String,
});
export type TradingEventsOccurrenceInput = typeof TradingEventsOccurrenceInput.Type;

/** The instant an ISO string names, treating a date-only string as UTC midnight. */
const parseInstant = (text: string): number | null => {
  const iso = /^\d{4}-\d{2}-\d{2}$/.exec(text.trim()) ? `${text.trim()}T00:00:00Z` : text.trim();
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Tool input to domain occurrence, or the refusal naming which one broke.
 *
 * Pure, and the only place the ISO conventions live: every caller that reads
 * tool input goes through here, so "date-only means midnight UTC" means one
 * thing rather than one thing per caller.
 */
export function parseTradingEventsOccurrence(
  input: TradingEventsOccurrenceInput,
): { readonly occurrence: TradingEventOccurrence } | { readonly reason: string } {
  const startAt = parseInstant(input.start);
  if (startAt === null) {
    return { reason: `start "${input.start}" is not an ISO date` };
  }
  let endAt: number;
  if (input.end === undefined) {
    // The start day's exclusive midnight: the whole day, whatever time it began.
    endAt = Math.floor(startAt / DAY_MS) * DAY_MS + DAY_MS;
  } else {
    const parsedEnd = parseInstant(input.end);
    if (parsedEnd === null) {
      return { reason: `end "${input.end}" is not an ISO date` };
    }
    endAt = /^\d{4}-\d{2}-\d{2}$/.test(input.end.trim()) ? parsedEnd + DAY_MS : parsedEnd;
  }
  return {
    occurrence: {
      startAt,
      endAt,
      ...(input.label === undefined ? {} : { label: input.label }),
      source: input.source,
    },
  };
}

export const TradingEventsInput = Schema.Struct({
  /** Attribution, never authority: an event set takes no mission state. */
  missionId: Schema.optional(Schema.String),
  action: Schema.optional(TradingEventsAction),
  /** Required by everything except `record` and `list`. */
  eventSetId: Schema.optional(Schema.String),
  /** Required by `record`. */
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Required by `record` and `add`: the dated occurrences with their sources. */
  occurrences: Schema.optional(Schema.Array(TradingEventsOccurrenceInput)),
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
});
export type TradingEventsInput = typeof TradingEventsInput.Type;

export const TradingEventsResult = Schema.Struct({
  /** Set by `record`, `add`, `show` and `retire`. */
  eventSet: Schema.optional(TradingEventSet),
  /** Set by `list`. */
  eventSets: Schema.optional(Schema.Array(TradingEventSetSummary)),
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
 * The vocabulary, served to the call that asked. Composed from the constants
 * that enforce it, the same discipline the backtest menu follows, so a cap
 * moved here changes the sentence without anybody remembering to.
 */
export function renderTradingEventsMenu(): string {
  return [
    "record {name, description?, occurrences: [{start, end?, label?, source}]} creates the set or fully replaces its dates (case-insensitive name, a retired set revives); re-recording is the correction path",
    `dates are ISO; date-only means UTC midnight, a date-only end means the next midnight, a missing end means the start day's end; an instantaneous event (an upgrade activation) records start and end as the same instant; every occurrence carries exactly one source (the URL, or "user provided"), never several URLs joined into one string, at most ${EVENT_SET_MAX_OCCURRENCES} a set`,
    "add {eventSetId, occurrences} appends; show {eventSetId}; retire {eventSetId} takes the set out of new theses but keeps evaluating saved ones; list",
    `study {eventSetId, market, interval?, horizonBars?, entryBasis?} measures the forward return after each occurrence against an every-bar baseline over the same horizon, entryBasis first_closed_bar_after_event (${EVENT_STUDY_ENTRY_BASIS_PHRASES.first_closed_bar_after_event}, the default) or first_bar_open_after_event, horizon default ${EVENT_STUDY_DEFAULT_HORIZON_BARS} up to ${EVENT_STUDY_MAX_HORIZON_BARS}; no fees, no sizing, occurrences outside archived history are reported rather than dropped`,
    "theses anchor with operand {source: event, eventSetId, label}: bars since the most recent ended occurrence; profit simulation stays trading_backtest's job",
  ].join(" · ");
}
