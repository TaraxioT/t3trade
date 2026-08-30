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
 * Occurrences that have not ended yet are excluded — their entry bars do not
 * exist to fetch — and a set with nothing ended, or whose first entry bar has
 * not opened yet, needs nothing: `null`, and the study reports those rows
 * uncovered with their reasons instead of pretending a recovery was possible.
 * This is the bounded context the study itself measures; bars between
 * occurrences arrive with the same window because it is contiguous.
 */
export function eventStudyHydrationWindow(
  occurrences: ReadonlyArray<TradingEventOccurrence>,
  input: { readonly intervalMs: number; readonly horizonBars: number; readonly now: number },
): { readonly fromT: number; readonly toT: number } | null {
  const ended = occurrences
    .map((occurrence) => occurrence.endAt)
    .filter((endAt) => endAt <= input.now);
  if (ended.length === 0 || input.intervalMs <= 0 || input.horizonBars < 1) return null;
  const firstEntryT = Math.ceil(Math.min(...ended) / input.intervalMs) * input.intervalMs;
  const lastEntryT = Math.ceil(Math.max(...ended) / input.intervalMs) * input.intervalMs;
  const lastExitT = lastEntryT + (input.horizonBars - 1) * input.intervalMs;
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
  input: { readonly intervalMs: number; readonly horizonBars: number; readonly now: number },
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
  const rawReturns: Array<number> = [];

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
      rows.push({
        ...base,
        covered: false,
        reason:
          `a recording gap covers the ${missingBars} bar(s) right after this event ended, ` +
          "so the bar its entry would have measured from is not archived",
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
    `dates are ISO; date-only means UTC midnight, a date-only end means the next midnight, a missing end means the start day's end; every occurrence needs a source (the URL, or "user provided"), at most ${EVENT_SET_MAX_OCCURRENCES} a set`,
    "add {eventSetId, occurrences} appends; show {eventSetId}; retire {eventSetId} takes the set out of new theses but keeps evaluating saved ones; list",
    `study {eventSetId, market, interval?, horizonBars?} measures the forward return after each occurrence against an every-bar baseline over the same horizon, horizon default ${EVENT_STUDY_DEFAULT_HORIZON_BARS} up to ${EVENT_STUDY_MAX_HORIZON_BARS}; no fees, no sizing, occurrences outside archived history are reported rather than dropped`,
    "theses anchor with operand {source: event, eventSetId, label}: bars since the most recent ended occurrence; profit simulation stays trading_backtest's job",
  ].join(" · ");
}
