/**
 * A forward validation's running verdict, as the card the reader asked for.
 *
 * Same posture as the backtest card next door, and for the same reason: the
 * default tool row folds a `trading_validate` result into "Validate" and the
 * answer to "how is my thesis doing" is inside it. Everything below is
 * DERIVED, not received — the server sends the report as structured data and
 * this composes the words, so mobile can render the same report natively off
 * the same contract.
 *
 * The one thing this card must never do is read like a statement of account.
 * Every figure on it is money that was not made or lost, and the card says so
 * in a place the eye cannot skip rather than in a footnote.
 *
 * @module tradingValidation
 */
import {
  describeExits,
  describeThesis,
  type TradingThesis,
} from "@t3tools/trading-contracts/thesis";

import { formatPrice, formatSignedUsd, formatUsd } from "./tradingFormat";
import { asRecord, readNumber, readTradingCardResult, signedTone } from "./cardPayload";

export interface ValidationStatLine {
  readonly label: string;
  readonly value: string;
  readonly tone: "positive" | "negative" | "neutral";
}

export interface ValidationCard {
  /** The label the user gave it, or the thesis composed into a line. */
  readonly headline: string;
  /** The exit rules, in the order they are checked. */
  readonly exits: ReadonlyArray<string>;
  /** "Validating on paper · 4 days left" — state and clock in one line. */
  readonly statusLine: string;
  /**
   * Whether the run is still going. Prose alone could not answer it: the card's
   * affordances ask a different question of a validation that is still on the
   * clock than of one that has finished, and parsing `statusLine` back out to
   * find that would be reading our own sentence.
   */
  readonly running: boolean;
  /** The headline number, with the sample-size caveat carried on it. */
  readonly expectancy: ValidationStatLine;
  readonly stats: ReadonlyArray<ValidationStatLine>;
  /** How it compares to the backtest that armed it, in prose. */
  readonly comparisonLabel: string;
  readonly comparisonTone: "positive" | "negative" | "neutral";
  /** The engine's own sentence. Never rewritten here. */
  readonly verdictReason: string;
  /** The open paper position, when there is one. */
  readonly openLine: string | null;
  readonly rawJson: string;
}

/**
 * Prose for each comparison. The card never shows the literal:
 * `too_few_trades` is a token for a switch statement, not something to put in
 * front of a person who asked how their idea is doing.
 */
const COMPARISON_LABELS: Record<string, string> = {
  tracking: "Tracking the backtest",
  better_than_backtest: "Running better than the backtest",
  worse_than_backtest: "Running worse than the backtest",
  no_baseline: "No backtest to compare against",
  too_few_trades: "Too few trades for a verdict",
};

/** The short form, for a chip or a badge that has no room for a sentence. */
const COMPARISON_SHORT_LABELS: Record<string, string> = {
  tracking: "tracking",
  better_than_backtest: "better than backtest",
  worse_than_backtest: "worse than backtest",
  no_baseline: "no backtest to compare",
  too_few_trades: "too few trades",
};

/**
 * The comparison in words, with the tone that goes with it.
 *
 * Exported because three surfaces now state the same verdict - the report
 * card, the chart's badge and the ideas panel's rows - and they cannot be
 * allowed to call the same literal different things. `tracking` reads positive
 * for the same reason the engine says it is not a compliment: a forward run
 * that matches its backtest is the outcome the validation was armed to find.
 */
export function describeComparison(
  comparison: string,
  form: "long" | "short" = "long",
): { readonly label: string; readonly tone: "positive" | "negative" | "neutral" } {
  const labels = form === "short" ? COMPARISON_SHORT_LABELS : COMPARISON_LABELS;
  return {
    label: labels[comparison] ?? (form === "short" ? "no verdict" : "No verdict"),
    tone:
      comparison === "better_than_backtest" || comparison === "tracking"
        ? "positive"
        : comparison === "worse_than_backtest"
          ? "negative"
          : "neutral",
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** "4 days left", "6 hours left", or what ended it. */
function statusLine(report: Record<string, unknown>): string {
  const status = typeof report.status === "string" ? report.status : "";
  if (status === "ended") {
    const reason =
      report.endReason === "expired"
        ? "ran its course"
        : report.endReason === "superseded"
          ? "was superseded by a newer version"
          : "ended";
    return `Paper validation ${reason}`;
  }
  const expiresAt = readNumber(report.expiresAt);
  const armedAt = readNumber(report.armedAt);
  const base = status === "paused" ? "Paused — paper only" : "Validating on paper";
  if (expiresAt === null) return base;
  // Measured from the report's own clock rather than the browser's: the two
  // can differ, and a card that says "2 hours left" about a validation the
  // server already expired is worse than one that says nothing.
  const from = armedAt === null ? Date.now() : Math.max(armedAt, Date.now());
  const left = expiresAt - from;
  if (left <= 0) return `${base} · finishing`;
  const days = left / DAY_MS;
  return days >= 1
    ? `${base} · ${Math.round(days)} days left`
    : `${base} · ${Math.max(1, Math.round(left / (60 * 60 * 1_000)))} hours left`;
}

/**
 * Read a card out of a `trading_validate` tool call, or null when the payload
 * carries no report — a `list`, a menu call, or a refusal, all of which fall
 * back to the ordinary tool row rather than rendering an empty card.
 *
 * A hand-parse rather than a schema decode, the same posture the backtest card
 * takes: a report that gained a field this build does not know about must
 * still render.
 */
export function deriveValidationCard(toolData: unknown): ValidationCard | null {
  const result = readTradingCardResult(toolData, "trading_validate");
  const report = asRecord(asRecord(result)?.report);
  if (report === null) return null;
  return validationCardFromReport(report, result);
}

/**
 * The same card, from a report that did not arrive on a tool call.
 *
 * The alert feed's expiry rows pull their report over its own RPC, and it is
 * the same report and must read as the same card. Split out rather than
 * duplicated so a change to what the card says lands in both places at once.
 *
 * `raw` is what the "every number behind this" drawer prints; the report
 * itself when nothing wrapped it.
 */
export function validationCardFromReport(
  report: Record<string, unknown>,
  raw: unknown = report,
): ValidationCard | null {
  const stats = asRecord(report.stats);
  const thesis = asRecord(report.thesis);
  if (stats === null || thesis === null) return null;

  const expectancy = readNumber(stats.expectancyUsd) ?? 0;
  const trades = readNumber(stats.tradesTaken) ?? 0;
  const winRate = readNumber(stats.winRatePercent) ?? 0;
  const drawdown = readNumber(stats.maxDrawdownUsd) ?? 0;
  const totalNet = readNumber(stats.totalNetUsd) ?? 0;
  const fees = readNumber(stats.totalFeesUsd) ?? 0;
  const bars = readNumber(report.barsWatched) ?? 0;
  const baseline = readNumber(report.baselineExpectancyUsd);
  const comparison = typeof report.comparison === "string" ? report.comparison : "";

  const open = asRecord(report.openTrade);
  const openEntry = open === null ? null : readNumber(open.entryPrice);

  const label = typeof report.headline === "string" ? report.headline : null;

  return {
    headline: label ?? describeThesis(thesis as unknown as TradingThesis),
    exits: describeExits((thesis.exits ?? {}) as TradingThesis["exits"]),
    statusLine: statusLine(report),
    running: report.status !== "ended",
    expectancy: {
      label: "Paper expectancy after fees",
      value: `${formatSignedUsd(expectancy)} a trade`,
      // Under the sample floor the number is printed but must not be coloured
      // as a result — a green figure over eleven trades reads as a finding.
      tone: comparison === "too_few_trades" ? "neutral" : signedTone(expectancy),
    },
    stats: [
      { label: "Paper trades", value: `${trades}`, tone: "neutral" },
      { label: "Hit rate", value: `${winRate.toFixed(1)}%`, tone: "neutral" },
      { label: "Total after fees", value: formatSignedUsd(totalNet), tone: signedTone(totalNet) },
      { label: "Fees paid", value: formatUsd(fees), tone: "neutral" },
      { label: "Worst drawdown", value: formatUsd(drawdown), tone: "neutral" },
      { label: "Bars watched", value: bars.toLocaleString("en-US"), tone: "neutral" },
      ...(baseline === null
        ? []
        : [
            {
              label: "Backtest expected",
              value: `${formatSignedUsd(baseline)} a trade`,
              tone: "neutral" as const,
            },
          ]),
    ],
    comparisonLabel: describeComparison(comparison).label,
    comparisonTone: describeComparison(comparison).tone,
    verdictReason: typeof report.verdictReason === "string" ? report.verdictReason : "",
    openLine:
      openEntry === null
        ? null
        : `One paper position is open, entered at ${formatPrice(openEntry)}`,
    rawJson: JSON.stringify(raw, null, 2),
  };
}
