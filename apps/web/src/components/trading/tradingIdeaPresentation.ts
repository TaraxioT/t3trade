/**
 * The ideas panel's rows, in words.
 *
 * The server sends numbers - an expectancy, a trade count, an expiry, a
 * comparison literal - and every sentence on the panel is composed here. Same
 * split the validation card takes, and for the same two reasons: the wording
 * is worth testing without a React tree, and mobile renders the same rows
 * natively off the same contract rather than off prose it would have to parse.
 *
 * @module tradingIdeaPresentation
 */
import type { TradingIdeaRow } from "@t3tools/contracts";

import { formatSignedUsd } from "./tradingFormat";
import { describeComparison } from "./tradingValidation";

/** One row, ready to render. */
export interface IdeaRowView {
  readonly id: string;
  readonly title: string;
  /** "ETH · 5m" - the two facts that say which series this is about. */
  readonly marketLine: string;
  readonly market: string;
  /** "Validating on paper", "Paused", "Testing". */
  readonly statusLabel: string;
  /** "4 days left", "6 hours left", or null when no clock is running. */
  readonly timeLeft: string | null;
  /** "+$1.20 a trade" or the honest absence. */
  readonly expectancyLabel: string;
  readonly expectancyTone: "positive" | "negative" | "neutral";
  /** "12 paper trades". Singular at one, and "no paper trades yet" at none. */
  readonly tradesLabel: string;
  readonly comparisonLabel: string;
  readonly comparisonTone: "positive" | "negative" | "neutral";
  /** The thread the row's question goes to. Null routes to the launcher. */
  readonly threadId: TradingIdeaRow["threadId"];
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

const STATUS_LABELS: Record<TradingIdeaRow["status"], string> = {
  armed: "Validating on paper",
  paused: "Paused — paper only",
  // Not "validating": the idea is filed as being under test and its runs have
  // finished, so saying it was validating would put a run on the clock that is
  // not on one.
  testing: "Testing — no run on the clock",
};

/**
 * How long is left, or null.
 *
 * Rounded to the coarser unit the whole way up: a panel of twenty rows counting
 * minutes is a panel that has to be re-read every minute, and no decision here
 * turns on the difference between five hours and six.
 */
export function timeLeftLabel(expiresAt: number | null, now: number): string | null {
  if (expiresAt === null) return null;
  const left = expiresAt - now;
  if (left <= 0) return "finishing";
  const days = left / DAY_MS;
  if (days >= 1) return plural(Math.round(days), "day");
  return plural(Math.max(1, Math.round(left / HOUR_MS)), "hour");
}

/** "1 day left", "4 days left". The row is read, not parsed. */
function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} left`;
}

/**
 * A served row as the panel renders it.
 *
 * `now` is passed rather than read so the derivation is a function of its
 * inputs, which is what makes the countdown testable at all.
 */
export function ideaRowView(row: TradingIdeaRow, now: number): IdeaRowView {
  const comparison = describeComparison(row.comparison, "short");
  // The row carries no baseline figure, so "tracking" is judged against what
  // the row does carry: the forward expectancy itself. Tracking while the
  // paper ledger loses money is replication rather than success, and a green
  // chip over a negative expectancy would say otherwise.
  const trackingWhileLosing =
    row.comparison === "tracking" && row.expectancyUsd !== null && row.expectancyUsd < 0;
  return {
    id: row.id,
    title: row.title,
    market: row.market,
    marketLine: `${row.market} · ${row.interval}`,
    statusLabel: STATUS_LABELS[row.status],
    timeLeft: timeLeftLabel(row.expiresAt, now),
    // A run with no settled trade has no expectancy, and $0.00 is a different
    // claim from "nothing has closed yet".
    expectancyLabel:
      row.expectancyUsd === null
        ? "no expectancy yet"
        : `${formatSignedUsd(row.expectancyUsd)} a trade`,
    expectancyTone:
      row.expectancyUsd === null || row.expectancyUsd === 0
        ? "neutral"
        : row.expectancyUsd > 0
          ? "positive"
          : "negative",
    tradesLabel:
      row.trades === 0
        ? "no paper trades yet"
        : `${row.trades} paper ${row.trades === 1 ? "trade" : "trades"}`,
    comparisonLabel: comparison.label,
    comparisonTone: trackingWhileLosing ? "neutral" : comparison.tone,
    threadId: row.threadId,
  };
}

/** What a row's affordance writes into the thread's composer. */
export function ideaStatusSentence(row: IdeaRowView): string {
  return `How is "${row.title}" doing on ${row.marketLine}, and what does the paper record say so far?`;
}
