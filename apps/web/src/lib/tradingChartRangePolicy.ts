/**
 * The pure range/bars policy for the unified graph.
 *
 * How much history a chart shows (its Range) and how wide each bar is (its
 * Bars) used to be one knob — the interval row — which made "1m" mean both
 * "one minute" and "one month" of history. They are two questions, so they
 * are two controls, and every rule that connects them lives here, pure, where
 * a wrong mapping fails a test instead of a reader.
 *
 * Nothing here talks to the server or knows what the archive holds. The
 * server resolves a range to a window (`all` is everything it recorded — the
 * client cannot know that span); this module only decides which interval to
 * request, whether a manual one is even servable on a range, and how many
 * bars that combination may ask for.
 *
 * @module tradingChartRangePolicy
 */
import type { TradingChartInterval, TradingChartRange } from "@t3tools/contracts";
import { STUDY_CHART_MAX_WINDOW_BARS, TRADING_CHART_INTERVAL_MILLIS } from "@t3tools/contracts";

/** The ranges the Range control offers, in rail order. */
export const RANGES: ReadonlyArray<TradingChartRange> = [
  "1d",
  "1w",
  "1m",
  "6m",
  "ytd",
  "1y",
  "all",
];

/**
 * Range display labels. `1M` is the month on the Range rail while `1m` never
 * appears there — the Bars menu speaks intervals in full words
 * (`intervalMenuLabel`), so no two controls can be read as the same thing.
 */
export const RANGE_LABELS: Readonly<Record<TradingChartRange, string>> = {
  "1d": "1D",
  "1w": "1W",
  "1m": "1M",
  "6m": "6M",
  ytd: "YTD",
  "1y": "1Y",
  all: "All",
};

/** The intervals the Bars menu offers, in axis order — the archive's set plus the derived wide pair. */
export const MENU_INTERVALS: ReadonlyArray<TradingChartInterval> = [
  "1m",
  "3m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1mo",
];

/** Every interval's menu label, spelled out. Never `1m` vs `1M` ambiguity in menus or accessible names. */
export const INTERVAL_MENU_LABELS: Readonly<Record<TradingChartInterval, string>> = {
  "1m": "1 min",
  "3m": "3 min",
  "5m": "5 min",
  "15m": "15 min",
  "1h": "1 hour",
  "4h": "4 hours",
  "1d": "1 day",
  "1w": "1 week",
  "1mo": "1 month",
};

export function intervalMenuLabel(interval: TradingChartInterval): string {
  return INTERVAL_MENU_LABELS[interval];
}

/** The complete resolved text for headers: `5 min bars`, `1 week bars`. */
export function resolvedBarsLabel(interval: TradingChartInterval): string {
  return `${INTERVAL_MENU_LABELS[interval]} bars`;
}

/**
 * Who is asking for an automatic interval. Browsing is the ordinary chart;
 * an event-study scene being fitted on the live graph wants coarser bars for
 * the same range, because a study measured on daily bars must stay legible
 * when its occurrences land years apart.
 */
export type RangePolicyContext = "browsing" | "event_study_fit";

const BROWSING_AUTO: Readonly<Record<TradingChartRange, TradingChartInterval>> = {
  "1d": "5m",
  "1w": "15m",
  "1m": "4h",
  "6m": "1d",
  ytd: "1w",
  "1y": "1w",
  all: "1w",
};

/** The automatic interval for a range: browsing's map, except a study fit keeps `6m` on weekly bars. */
export function autoInterval(
  range: TradingChartRange,
  context: RangePolicyContext,
): TradingChartInterval {
  if (context === "event_study_fit" && range === "6m") return "1w";
  return BROWSING_AUTO[range];
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a range spans, in millis. `ytd` is measured from the start of the
 * current UTC year to `now`; `all` is unbounded (null) because only the
 * server knows what the archive recorded.
 */
export function rangeDurationMillis(range: TradingChartRange, now: number): number | null {
  switch (range) {
    case "1d":
      return DAY_MS;
    case "1w":
      return 7 * DAY_MS;
    case "1m":
      return 30 * DAY_MS;
    case "6m":
      return 183 * DAY_MS;
    case "ytd":
      return Math.max(0, now - Date.UTC(new Date(now).getUTCFullYear(), 0, 1));
    case "1y":
      return 365 * DAY_MS;
    case "all":
      return null;
  }
}

/**
 * Whether a manually chosen interval can honestly serve a range: the range
 * must span at least two buckets of it, or the chart is one fat bar pretending
 * to be a series. `all` is always servable — its span is the archive's, and
 * the server cuts it to its own cap.
 */
export function servable(
  range: TradingChartRange,
  interval: TradingChartInterval,
  now: number,
): boolean {
  const duration = rangeDurationMillis(range, now);
  if (duration === null) return true;
  return duration >= 2 * TRADING_CHART_INTERVAL_MILLIS[interval];
}

/** What the graph actually requests after a Bars choice met a Range choice. */
export interface ResolvedBars {
  readonly interval: TradingChartInterval;
  /**
   * `"manual"`: the user's choice stood. `"auto"`: Bars is Auto.
   * `"auto-fallback"`: a manual choice was not servable on this range, so the
   * automatic interval serves instead — never a silent impossible request.
   */
  readonly mode: "auto" | "manual" | "auto-fallback";
}

/** Resolve one Range + Bars state into the interval the live read requests. */
export function resolveBars(
  range: TradingChartRange,
  manual: TradingChartInterval | null,
  now: number,
): ResolvedBars {
  if (manual !== null && servable(range, manual, now)) {
    return { interval: manual, mode: "manual" };
  }
  return {
    interval: autoInterval(range, "browsing"),
    mode: manual === null ? "auto" : "auto-fallback",
  };
}

/**
 * The `maxBars` a range read asks for: how many buckets the range spans,
 * capped by the server's public ceiling. `all` asks for the whole cap because
 * only the server knows where the archive starts.
 */
export function rangeMaxBars(
  range: TradingChartRange,
  interval: TradingChartInterval,
  now: number,
): number {
  if (range === "all") return STUDY_CHART_MAX_WINDOW_BARS;
  const duration = rangeDurationMillis(range, now);
  if (duration === null) return STUDY_CHART_MAX_WINDOW_BARS;
  return Math.max(
    1,
    Math.min(
      Math.ceil(duration / TRADING_CHART_INTERVAL_MILLIS[interval]),
      STUDY_CHART_MAX_WINDOW_BARS,
    ),
  );
}

/**
 * Whether an `all`-range weekly read should step up to monthly bars: when the
 * weeks the archive has recorded no longer fit the bar budget, weekly bars
 * would either truncate the history or arrive past the cap. The count includes
 * the current partial week, hence the +1.
 */
export function promoteAllToMonthly(recordingSince: number, now: number, budget: number): boolean {
  const weeks = Math.floor((now - recordingSince) / TRADING_CHART_INTERVAL_MILLIS["1w"]);
  return weeks + 1 > budget;
}

/**
 * The smallest fixed range whose span `[now - duration, now]` holds both
 * instants of a scene, `all` when none does. Pure date arithmetic: `6m` is
 * tried before `ytd` before `1y`, so a scene that fits half a year never
 * jumps to everything. An instant after `now` (an upcoming occurrence) fits
 * no closed span by construction, which is honest: showing it needs the
 * archive's whole width.
 */
export function sceneAutoFit(
  earliestStartAt: number,
  latestRelevantAt: number,
  now: number,
): TradingChartRange {
  const candidates: ReadonlyArray<TradingChartRange> = ["6m", "ytd", "1y"];
  for (const candidate of candidates) {
    const duration = rangeDurationMillis(candidate, now);
    if (duration === null) continue;
    if (earliestStartAt >= now - duration && latestRelevantAt <= now) {
      return candidate;
    }
  }
  return "all";
}
