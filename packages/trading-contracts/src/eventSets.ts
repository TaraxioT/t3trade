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
import { UnixMillis } from "./primitives.ts";

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

// ---------------------------------------------------------------------------
// the study
// ---------------------------------------------------------------------------

/** What the study could measure for one occurrence, and what it could not. */
export interface EventStudyRow {
  readonly startAt: number;
  readonly endAt: number;
  /** The occurrence's own label, when it carries one. */
  readonly label: string | undefined;
  /** Where the date came from, so the row can be checked. */
  readonly source: string;
  readonly covered: boolean;
  /** Present on every uncovered row: why the archive could not measure it. */
  readonly reason: string | undefined;
  readonly entryTime: number | undefined;
  readonly entryPrice: number | undefined;
  readonly exitTime: number | undefined;
  readonly exitPrice: number | undefined;
  /**
   * Signed, long convention: (exit - entry) / entry as a percentage. The
   * study takes no view on side; a short reads the same number negated.
   */
  readonly returnPct: number | undefined;
  /** True when the window ran out before the horizon did. */
  readonly truncated: boolean;
  /** Bars actually measured, horizonBars when not truncated. */
  readonly barsCovered: number | undefined;
}

/**
 * The same question asked of every bar rather than every event: what did a
 * horizon-length forward return look like sampled across the whole window?
 * The event's numbers are read against this, because "up 8 percent after
 * Breakpoint" is only interesting if the market was not going up 8 percent
 * over every 30 bars anyway.
 */
export interface EventStudyBaseline {
  readonly samples: number;
  readonly meanReturnPct: number;
  readonly medianReturnPct: number;
}

export interface EventStudyReport {
  readonly horizonBars: number;
  /** The horizon in wall-clock time, for the surfaces that say it in words. */
  readonly horizonMs: number;
  readonly n: number;
  readonly nCovered: number;
  /** Null when nothing was covered. Never guessed, never zero. */
  readonly meanReturnPct: number | null;
  readonly medianReturnPct: number | null;
  /** Share of covered occurrences with a return above zero. */
  readonly hitRatePercent: number | null;
  readonly bestReturnPct: number | null;
  readonly worstReturnPct: number | null;
  /** Null when the served window is shorter than the horizon. */
  readonly baseline: EventStudyBaseline | null;
  readonly rows: ReadonlyArray<EventStudyRow>;
  /** Coverage first, numbers second, and never a claim of significance. */
  readonly verdict: string;
}

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
 * Per occurrence: entry is the open of the first candle whose open time is at
 * or after `endAt`, exit is the close `horizonBars - 1` bars later, truncated
 * at the last served close when the window runs out first. Occurrences the
 * archive cannot see (they predate it, or have not happened yet) are reported
 * as uncovered with their reason, never silently dropped: a mean computed over
 * the survivors of a silent filter is the most misleading number this module
 * could produce.
 *
 * `candles` is oldest first. Assumes `checkEventStudy` passed.
 */
export function runEventStudy(input: {
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly intervalMs: number;
  readonly horizonBars: number;
}): EventStudyReport {
  const { occurrences, candles, intervalMs, horizonBars } = input;
  const rows: Array<EventStudyRow> = [];

  const firstOpen = candles[0]?.openTime;
  const lastOpen = candles.length === 0 ? undefined : candles[candles.length - 1]?.openTime;

  for (const occurrence of occurrences) {
    const base = {
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
      label: occurrence.label,
      source: occurrence.source,
    };
    if (firstOpen === undefined || lastOpen === undefined) {
      rows.push({
        ...base,
        covered: false,
        reason: "the archive holds no bars for this market, so there is nothing to measure against",
        entryTime: undefined,
        entryPrice: undefined,
        exitTime: undefined,
        exitPrice: undefined,
        returnPct: undefined,
        truncated: false,
        barsCovered: undefined,
      });
      continue;
    }
    if (occurrence.endAt > lastOpen) {
      rows.push({
        ...base,
        covered: false,
        reason: "still in the future: it ends after the last archived bar",
        entryTime: undefined,
        entryPrice: undefined,
        exitTime: undefined,
        exitPrice: undefined,
        returnPct: undefined,
        truncated: false,
        barsCovered: undefined,
      });
      continue;
    }
    if (occurrence.endAt < firstOpen) {
      rows.push({
        ...base,
        covered: false,
        reason: "before the archived window: the bar it would have entered on is not recorded",
        entryTime: undefined,
        entryPrice: undefined,
        exitTime: undefined,
        exitPrice: undefined,
        returnPct: undefined,
        truncated: false,
        barsCovered: undefined,
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
      rows.push({
        ...base,
        covered: false,
        reason: "the archived window holds no bar at or after the event ended",
        entryTime: undefined,
        entryPrice: undefined,
        exitTime: undefined,
        exitPrice: undefined,
        returnPct: undefined,
        truncated: false,
        barsCovered: undefined,
      });
      continue;
    }
    const truncated = exitIndex < exitWanted;
    rows.push({
      ...base,
      covered: true,
      reason: undefined,
      entryTime: entryBar.openTime,
      entryPrice: entryBar.open,
      exitTime: exitBar.closeTime,
      exitPrice: exitBar.close,
      returnPct: round2(((exitBar.close - entryBar.open) / entryBar.open) * 100),
      truncated,
      barsCovered: exitIndex - entryIndex + 1,
    });
  }

  const covered = rows.filter((row) => row.covered);
  const returns = covered.map((row) => row.returnPct as number);
  const mean =
    returns.length === 0 ? null : returns.reduce((sum, value) => sum + value, 0) / returns.length;

  // Sampled at every bar the horizon fits behind. Rolling windows overlap, so
  // consecutive samples share bars and the baseline understates the variance
  // of a single horizon-length return; it is a center-of-mass comparison, not
  // a significance test, and is never spoken of as one.
  const samples: Array<number> = [];
  for (let index = 0; index + horizonBars <= candles.length; index += 1) {
    const entryBar = candles[index];
    const exitBar = candles[index + horizonBars - 1];
    if (entryBar === undefined || exitBar === undefined || !(entryBar.open > 0)) continue;
    samples.push(((exitBar.close - entryBar.open) / entryBar.open) * 100);
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
