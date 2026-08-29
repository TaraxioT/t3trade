/**
 * A forward validation, as the market chart draws it.
 *
 * Pure derivation, for the same reason `marketChartOverlays` is: the rules
 * about what may and may not be drawn are worth testing without an SVG, and
 * the badge's words are worth pinning.
 *
 * Four things ride on the chart when a thesis is being validated on the viewed
 * market: a badge naming the thesis and how it is doing, markers at the paper
 * entries and exits, bands around an open paper trade's bracket, and the entry
 * rule's own price levels.
 *
 * They divide on one question - is this a claim about a TIME or about a PRICE.
 * The badge and the levels are claims about prices and are drawn on every
 * timeframe. The markers and the bands are claims about moments, and a 5m
 * thesis has entries at 5m bar opens, so drawing those on a 1m chart would put
 * marks at times the rule never fired. The server decides which chart is the
 * thesis's own (`intervalMatches`) and this composes what to say about it.
 *
 * @module thesisChartMarkers
 */
import type { TradingChartThesis } from "@t3tools/contracts";

import type { ChartCondition, ChartZoneInput } from "./missionChartGeometry";
import { describeComparison } from "./tradingValidation";
import { formatSignedUsd, formatPrice } from "./tradingPresentation";
import type { ChartFillKind, ChartFillMarker } from "./tradingWatchStream";

/** What the badge says, and whether the chart may draw markers underneath it. */
export interface ThesisChartBadge {
  /** "The 5m fade" or the composed thesis line. */
  readonly headline: string;
  /**
   * The qualifier under the headline. Always says paper; says which timeframe
   * to switch to when the markers are being withheld.
   */
  readonly note: string;
  readonly paused: boolean;
  /** True when markers are being drawn; false when only the badge is. */
  readonly showsMarkers: boolean;
  /**
   * How the run is doing against the backtest that armed it, in two or three
   * words, with the tone that goes with them.
   *
   * The badge used to say only what was running. What a reader actually wants
   * from a validation on their chart is whether it is working, and that answer
   * already exists as the running verdict - it was simply never carried this
   * far. The wording comes from the shared `describeComparison` so the badge,
   * the report card and the ideas panel cannot disagree.
   */
  readonly comparisonLabel: string;
  readonly comparisonTone: "positive" | "negative" | "neutral";
}

export function thesisChartBadge(thesis: TradingChartThesis): ThesisChartBadge {
  const paused = thesis.status === "paused";
  const base = paused ? "Paused — paper only" : "Validating on paper";
  const comparison = describeComparison(thesis.comparison, "short");
  return {
    headline: thesis.headline,
    // The mismatch note names the timeframe rather than saying markers are
    // hidden. A reader who wants to see the trades needs the next action, not
    // an explanation of the absence.
    note: thesis.intervalMatches
      ? `${base}, no orders`
      : `${base} on ${thesis.interval} — switch to ${thesis.interval} to see its trades`,
    paused,
    showsMarkers: thesis.intervalMatches,
    comparisonLabel: comparison.label,
    comparisonTone: comparison.tone,
  };
}

/**
 * The open paper trade's bracket, as two bands.
 *
 * Two rather than one, and the choice is the point. A single band from stop to
 * target is one uniform wash over two regions that mean opposite things, and
 * nothing in the picture says where inside it the entry sits - so the reader
 * has to find the entry marker, which only exists at the one x where the fill
 * happened. Split at the entry, the boundary between the bands IS the entry
 * line, drawn the full width of the plot, and the two areas read as what they
 * are: what this trade can lose, and what it can make. It also degrades: a
 * thesis that names a stop and no target draws the risk band alone rather than
 * refusing to draw anything.
 *
 * Empty when nothing is open. A settled trade's bracket is a fact about a
 * moment that has passed, and washing it across a plot whose right edge is now
 * would claim the level still applies.
 */
export function thesisChartZones(thesis: TradingChartThesis): ReadonlyArray<ChartZoneInput> {
  if (!thesis.intervalMatches) return [];
  const open = thesis.trades.find((trade) => trade.exitTime === null) ?? null;
  if (open === null) return [];

  const zones: Array<ChartZoneInput> = [];
  if (open.stopPrice !== null) {
    zones.push({
      key: `paper-risk-${open.id}`,
      label: "paper risk",
      priceLow: Math.min(open.entryPrice, open.stopPrice),
      priceHigh: Math.max(open.entryPrice, open.stopPrice),
      tone: "risk",
      // Hypothetical, whatever the exchange is doing: nothing is resting at
      // these prices. The band is what the paper rule would do, not an order.
      register: "hypothetical",
    });
  }
  if (open.targetPrice !== null) {
    zones.push({
      key: `paper-reward-${open.id}`,
      label: "paper target",
      priceLow: Math.min(open.entryPrice, open.targetPrice),
      priceHigh: Math.max(open.entryPrice, open.targetPrice),
      tone: "reward",
      register: "hypothetical",
    });
  }
  return zones;
}

/**
 * The thesis's entry rule as levels, when the rule names a price at all.
 *
 * Drawn on EVERY interval, unlike the trade markers: the markers are a claim
 * about when the rule fired, which is only true on the thesis's own bars, and
 * a level is a claim about a price, which does not change with the bars it is
 * read on.
 *
 * Inexpressible predicates - price against a moving average, an indicator
 * against a number - contribute nothing and say nothing about it. The badge
 * already names the thesis, so a chart with no drawn level is not a chart that
 * has hidden something; it is a rule that is not a horizontal line.
 */
export function thesisChartConditions(thesis: TradingChartThesis): ReadonlyArray<ChartCondition> {
  return thesis.entryLevels.map((level) => ({
    price: level.price,
    direction: level.direction,
    // Never "met": nothing is armed on this level, so there is no watch whose
    // predicate could be satisfied. A green condition chip would say the
    // mission had reached something.
    met: false,
    label: thesis.headline,
    register: "hypothetical",
  }));
}

/**
 * The paper trades as chart markers: one at the entry, one at the exit of
 * every trade that has closed.
 *
 * An open paper trade contributes its entry and nothing else — there is no
 * honest x or y for an exit that has not happened. The exit's colour comes
 * from what the trade actually netted after fees, which is the number the
 * validation is judged on rather than the gross the price difference implies.
 */
export function thesisChartMarkers(thesis: TradingChartThesis): ReadonlyArray<ChartFillMarker> {
  if (!thesis.intervalMatches) return [];

  const markers: Array<ChartFillMarker> = [];
  for (const trade of thesis.trades) {
    markers.push({
      key: `paper-entry-${trade.id}`,
      at: trade.entryTime,
      price: trade.entryPrice,
      kind: "paper_open",
      label: `Paper entry ${formatPrice(trade.entryPrice)}`,
    });

    if (trade.exitTime === null || trade.exitPrice === null) continue;

    const net = trade.netUsd;
    const kind: ChartFillKind =
      net === null || net === 0 ? "paper_flat" : net > 0 ? "paper_profit" : "paper_loss";
    const reason = trade.exitReason === null ? "" : ` (${trade.exitReason.replaceAll("_", " ")})`;
    markers.push({
      key: `paper-exit-${trade.id}`,
      at: trade.exitTime,
      price: trade.exitPrice,
      kind,
      label:
        `Paper exit ${formatPrice(trade.exitPrice)}${reason}` +
        (net === null ? "" : ` · ${formatSignedUsd(net)} net`),
    });
  }
  return markers;
}
