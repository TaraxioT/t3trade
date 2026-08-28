import {
  describeExits,
  describeThesis,
  type TradingThesis,
} from "@t3tools/trading-contracts/thesis";
import { formatSignedUsd, formatUsd } from "./tradingFormat";

// ---------------------------------------------------------------------------
// backtest result cards
// ---------------------------------------------------------------------------
//
// A `trading_backtest` result is a few hundred characters of JSON, and in the
// timeline's default rendering it is a collapsed tool row the reader has to
// open to learn whether their idea makes money. It is the answer to the
// question they asked, so it gets a card.
//
// Everything below is DERIVED, not received. The server sends the report as
// structured data and this composes the words, so the mobile client can render
// the same report natively off the same contract instead of parsing sentences
// somebody else wrote.

/** One measured figure on the card. */
export interface BacktestStatLine {
  readonly label: string;
  readonly value: string;
  /** Whether the number is good, bad, or simply a fact. Drives the tone only. */
  readonly tone: "positive" | "negative" | "neutral";
}

export interface BacktestCard {
  /** "Buy ETH 15m when RSI(14) is below 30 and price is above EMA(50)". */
  readonly headline: string;
  /** The exit rules, in the order they are checked. */
  readonly exits: ReadonlyArray<string>;
  /** The one number the whole thing is about. */
  readonly expectancy: BacktestStatLine;
  readonly stats: ReadonlyArray<BacktestStatLine>;
  readonly verdictLabel: string;
  readonly verdictTone: "positive" | "negative" | "neutral";
  /** The engine's own sentence. Never rewritten here. */
  readonly verdictReason: string;
  /** What the archive could and could not serve, in one line. */
  readonly coverageLine: string;
  /** The raw payload, for the reader who wants the numbers behind the numbers. */
  readonly rawJson: string;
}

/**
 * Prose for each verdict. The card never shows the literal: `insufficient_
 * sample` is a token for a switch statement, not something to put in front of
 * a person who asked whether their idea works.
 */
const VERDICT_LABELS: Record<string, string> = {
  positive_after_fees: "Positive after fees",
  negative_after_fees: "Negative after fees",
  insufficient_sample: "Not enough trades for a verdict",
};

const DAY_MS = 24 * 60 * 60 * 1_000;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const formatDays = (millis: number): string => {
  const days = millis / DAY_MS;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hours`;
  return `${Math.round(days)} days`;
};

const signedTone = (value: number): "positive" | "negative" | "neutral" =>
  value > 0 ? "positive" : value < 0 ? "negative" : "neutral";

/**
 * The coverage sentence: what was asked for, what was actually served, and
 * every way the answer is less complete than it looks.
 *
 * This is the line that keeps the card honest. A thesis tested over eleven
 * days of a market the archive only started recording last week is not a
 * verdict about that thesis, and the only way a reader can know that is if the
 * card says so next to the number.
 */
function coverageLine(coverage: Record<string, unknown>, costs: Record<string, unknown>): string {
  const parts: string[] = [];
  const bars = readNumber(coverage.barsServed);
  const servedFrom = readNumber(coverage.servedFromT);
  const servedTo = readNumber(coverage.servedToT);
  const requestedFrom = readNumber(coverage.requestedFromT);

  if (bars !== null && servedFrom !== null && servedTo !== null) {
    parts.push(`${bars.toLocaleString()} bars over ${formatDays(servedTo - servedFrom)}`);
    // Only worth saying when the archive could not cover what was asked for.
    // A window served in full needs no apology.
    if (requestedFrom !== null && servedFrom - requestedFrom > DAY_MS) {
      parts.push(`asked for ${formatDays(servedTo - requestedFrom)}, recording starts later`);
    }
  } else {
    parts.push("no bars served");
  }

  const gaps = Array.isArray(coverage.gaps) ? coverage.gaps.length : 0;
  parts.push(gaps === 0 ? "no known gaps" : `${gaps} known ${gaps === 1 ? "gap" : "gaps"}`);
  parts.push(coverage.fundingServed === true ? "funding charged" : "no funding recorded");

  const taker = readNumber(costs.takerFeeBpsPerSide);
  const slippage = readNumber(costs.slippageBpsPerSide);
  if (taker !== null && slippage !== null) {
    const source = costs.slippageSource === "archived_book" ? "measured" : "assumed";
    parts.push(
      `costs ${taker} bps taker a side plus ${slippage.toFixed(2)} bps crossing (${source})`,
    );
  }
  return parts.join(", ");
}

/**
 * The tool's own answer, out of the MCP envelope it arrives in.
 *
 * The transport wraps every result as `content: [{type: "text", text}]` with
 * the JSON inside the text, so it is unwrapped one level and parsed. A result
 * that is already an object is taken as it is, because that is what the
 * handler returns before the transport touches it and what the tests build.
 */
function readBacktestResult(toolData: unknown): unknown {
  const item = asRecord(toolData);
  if (item === null || item.tool !== "trading_backtest") return null;
  const result = asRecord(item.result);
  if (result === null) return null;

  const content = result.content;
  if (!Array.isArray(content)) return result;
  for (const entry of content) {
    const text = asRecord(entry)?.text;
    if (typeof text !== "string") continue;
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON, so not a report. The ordinary tool row still renders it.
      return null;
    }
  }
  return null;
}

/**
 * Read a card out of a `trading_backtest` tool call, or null when the payload
 * is not one.
 *
 * A hand-parse rather than a schema decode, the same posture the wakeup card
 * takes: a report that gained a field this build does not know about must
 * still render, and a menu call (which carries no report at all) must fall
 * back to the ordinary tool row rather than rendering an empty card.
 */
export function deriveBacktestCard(toolData: unknown): BacktestCard | null {
  const result = readBacktestResult(toolData);
  const report = asRecord(asRecord(result)?.report);
  if (report === null) return null;

  const stats = asRecord(report.stats);
  const coverage = asRecord(report.coverage);
  const costs = asRecord(report.costs);
  const thesis = asRecord(report.thesis);
  if (stats === null || coverage === null || costs === null || thesis === null) return null;

  const expectancy = readNumber(stats.expectancyUsd) ?? 0;
  const trades = readNumber(stats.tradesTaken) ?? 0;
  const setups = readNumber(stats.setupsFound) ?? 0;
  const winRate = readNumber(stats.winRatePercent) ?? 0;
  const averageWin = readNumber(stats.averageWinUsd) ?? 0;
  const averageLoss = readNumber(stats.averageLossUsd) ?? 0;
  const drawdown = readNumber(stats.maxDrawdownUsd) ?? 0;
  const timeInMarket = readNumber(stats.timeInMarketPercent) ?? 0;
  const buyAndHold = readNumber(stats.buyAndHoldNetUsd) ?? 0;
  const totalNet = readNumber(stats.totalNetUsd) ?? 0;
  const notional = readNumber(report.notionalUsd) ?? 0;

  const verdict = typeof report.verdict === "string" ? report.verdict : "";

  return {
    headline: describeThesis(thesis as unknown as TradingThesis),
    exits: describeExits((thesis.exits ?? {}) as TradingThesis["exits"]),
    expectancy: {
      label: "Expectancy after fees",
      value: `${formatSignedUsd(expectancy)} a trade`,
      tone: signedTone(expectancy),
    },
    stats: [
      {
        // Setups and trades are different numbers and the gap between them is
        // information: the ones that were skipped happened while a position
        // from an earlier signal was still open.
        label: "Trades",
        value: setups > trades ? `${trades} of ${setups} setups` : `${trades}`,
        tone: "neutral",
      },
      { label: "Win rate", value: `${winRate.toFixed(1)}%`, tone: "neutral" },
      { label: "Average win", value: formatUsd(averageWin), tone: "neutral" },
      { label: "Average loss", value: formatUsd(averageLoss), tone: "neutral" },
      { label: "Total after fees", value: formatSignedUsd(totalNet), tone: signedTone(totalNet) },
      { label: "Worst drawdown", value: formatUsd(drawdown), tone: "neutral" },
      { label: "Time in market", value: `${timeInMarket.toFixed(1)}%`, tone: "neutral" },
      {
        label: "Buy and hold",
        value: formatSignedUsd(buyAndHold),
        tone: signedTone(buyAndHold),
      },
    ],
    verdictLabel: VERDICT_LABELS[verdict] ?? "No verdict",
    verdictTone:
      verdict === "positive_after_fees"
        ? "positive"
        : verdict === "negative_after_fees"
          ? "negative"
          : "neutral",
    verdictReason: typeof report.verdictReason === "string" ? report.verdictReason : "",
    coverageLine: `${notional > 0 ? `${formatUsd(notional)} a trade, ` : ""}${coverageLine(coverage, costs)}`,
    rawJson: JSON.stringify(result, null, 2),
  };
}
