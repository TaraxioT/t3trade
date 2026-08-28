/**
 * A forward validation, as the market chart draws it.
 *
 * Pure derivation, for the same reason `marketChartOverlays` is: the rules
 * about what may and may not be drawn are worth testing without an SVG, and
 * the badge's words are worth pinning.
 *
 * Two things ride on the chart when a thesis is being validated on the viewed
 * market: markers at the paper entries and exits, and a badge naming the
 * thesis. The badge is always drawn; the markers are drawn only when the
 * chart's timeframe is the thesis's own, because a 5m thesis has entries at 5m
 * bar opens and drawing those on a 1m chart would put marks at times the rule
 * never fired. The server decides that (`intervalMatches`) and this composes
 * what to say about it.
 *
 * @module thesisChartMarkers
 */
import type { TradingChartThesis } from "@t3tools/contracts";

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
}

export function thesisChartBadge(thesis: TradingChartThesis): ThesisChartBadge {
  const paused = thesis.status === "paused";
  const base = paused ? "Paused — paper only" : "Validating on paper";
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
  };
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
