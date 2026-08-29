/**
 * A hypothesis, as the card that shows what happened to it.
 *
 * The reason this exists is the same reason the backtest and validation cards
 * do: the default tool row folds a `trading_hypothesis` result into the word
 * "Hypothesis", and the answer to "where did that idea get to" is inside it.
 *
 * What is different here is what the card is FOR. The other two answer a
 * question about one measurement; this one answers a question about time. It
 * has to make the shape of the refinement legible at a glance - which version
 * is current, what each version scored, and whether anything is still running
 * against it - or the record is just a filing cabinet nobody opens.
 *
 * Everything below is DERIVED, not received. The server sends structured data
 * and this composes the words, so mobile can render the same record natively
 * off the same contract.
 *
 * @module tradingHypothesis
 */
import {
  describeHypothesisStatus,
  type HypothesisStatus,
} from "@t3tools/trading-contracts/hypothesis";
import {
  describeExits,
  describeThesis,
  type TradingThesis,
} from "@t3tools/trading-contracts/thesis";

import { formatSignedUsd, formatUsd } from "./tradingFormat";

export type CardTone = "positive" | "negative" | "neutral";

/** One backtest run, as one line under its version. */
export interface HypothesisRunLine {
  readonly runId: string;
  /** "v2" or "unversioned" for a run taken before the idea was filed. */
  readonly versionLabel: string;
  readonly market: string;
  readonly expectancy: string;
  readonly tone: CardTone;
  /** "25 trades · 52.0% hit rate · $8.00 worst drawdown". */
  readonly detail: string;
  readonly verdictLabel: string;
}

/** One linked validation, as one line. */
export interface HypothesisValidationLine {
  readonly validationId: string;
  readonly versionLabel: string;
  /** "ETH 5m · validating on paper" or "· superseded". */
  readonly statusLine: string;
  readonly comparisonLabel: string;
  readonly tone: CardTone;
  readonly detail: string;
}

export interface HypothesisCard {
  readonly hypothesisId: string;
  readonly title: string;
  /** "Testing · v3" - state and lineage in the place the eye lands first. */
  readonly statusLabel: string;
  readonly statusTone: CardTone;
  /** The current version's thesis in one line. */
  readonly headline: string;
  /** The current version's exit rules, in the order they are checked. */
  readonly exits: ReadonlyArray<string>;
  /** Why the current version exists, in the words it was written with. */
  readonly currentNote: string;
  readonly runs: ReadonlyArray<HypothesisRunLine>;
  readonly validations: ReadonlyArray<HypothesisValidationLine>;
  /** Present once the idea has been concluded or shelved with a reason. */
  readonly conclusion: string | null;
  /** Set when the card is showing a window onto a longer history. */
  readonly windowNote: string | null;
  readonly rawJson: string;
}

const VERDICT_LABELS: Record<string, string> = {
  positive_after_fees: "Positive after fees",
  negative_after_fees: "Negative after fees",
  insufficient_sample: "Not enough trades",
};

const COMPARISON_LABELS: Record<string, string> = {
  tracking: "Tracking the backtest",
  better_than_backtest: "Better than the backtest",
  worse_than_backtest: "Worse than the backtest",
  no_baseline: "No backtest to compare against",
  too_few_trades: "Too few trades for a verdict",
};

/**
 * The tone a status carries.
 *
 * `unsupported` is deliberately neutral rather than negative. An idea proven
 * wrong is the cheapest result this product can hand somebody, and colouring
 * it like a loss would teach the reader to avoid concluding.
 */
const STATUS_TONES: Record<HypothesisStatus, CardTone> = {
  exploring: "neutral",
  testing: "neutral",
  supported: "positive",
  unsupported: "neutral",
  shelved: "neutral",
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const signedTone = (value: number): CardTone =>
  value > 0 ? "positive" : value < 0 ? "negative" : "neutral";

const versionLabel = (value: unknown): string => {
  const version = readNumber(value);
  return version === null ? "unversioned" : `v${version}`;
};

function runLine(raw: unknown): HypothesisRunLine | null {
  const run = asRecord(raw);
  const runId = run === null ? null : readString(run.runId);
  if (run === null || runId === null) return null;
  const expectancy = readNumber(run.expectancyUsd) ?? 0;
  const trades = readNumber(run.tradesTaken) ?? 0;
  const winRate = readNumber(run.winRatePercent) ?? 0;
  const drawdown = readNumber(run.maxDrawdownUsd) ?? 0;
  const verdict = readString(run.verdict) ?? "";
  return {
    runId,
    versionLabel: versionLabel(run.version),
    market: `${readString(run.market) ?? ""} ${readString(run.interval) ?? ""}`.trim(),
    expectancy: `${formatSignedUsd(expectancy)} a trade`,
    // Under the sample floor the figure is printed but not coloured as a
    // result, the same rule the validation card follows.
    tone: verdict === "insufficient_sample" ? "neutral" : signedTone(expectancy),
    detail: `${trades} trades · ${winRate.toFixed(1)}% hit rate · ${formatUsd(drawdown)} worst drawdown`,
    verdictLabel: VERDICT_LABELS[verdict] ?? "No verdict",
  };
}

function validationLine(raw: unknown): HypothesisValidationLine | null {
  const entry = asRecord(raw);
  const validationId = entry === null ? null : readString(entry.validationId);
  if (entry === null || validationId === null) return null;
  const status = readString(entry.status) ?? "";
  const comparison = readString(entry.comparison) ?? "";
  const expectancy = readNumber(entry.expectancyUsd) ?? 0;
  const trades = readNumber(entry.tradesTaken) ?? 0;
  const state =
    status === "armed" ? "validating on paper" : status === "paused" ? "paused" : "ended";
  return {
    validationId,
    versionLabel: versionLabel(entry.version),
    statusLine:
      `${readString(entry.market) ?? ""} ${readString(entry.interval) ?? ""} · ${state}`.trim(),
    comparisonLabel: COMPARISON_LABELS[comparison] ?? "No verdict",
    tone:
      comparison === "too_few_trades" || comparison === "no_baseline"
        ? "neutral"
        : comparison === "worse_than_backtest"
          ? "negative"
          : signedTone(expectancy),
    detail: `${trades} paper ${trades === 1 ? "trade" : "trades"} · ${formatSignedUsd(expectancy)} a trade`,
  };
}

/**
 * Read a card out of a `trading_hypothesis` tool call, or null when the
 * payload carries no hypothesis - a `list`, a menu call, or a refusal, all of
 * which fall back to the ordinary tool row rather than rendering an empty
 * card.
 *
 * A hand-parse rather than a schema decode, the same posture the two cards
 * next door take: a record that gained a field this build does not know about
 * must still render.
 */
export function deriveHypothesisCard(toolData: unknown): HypothesisCard | null {
  const result = readHypothesisResult(toolData);
  const record = asRecord(asRecord(result)?.hypothesis);
  if (record === null) return null;

  const thesis = asRecord(record.thesis);
  const title = readString(record.title);
  const hypothesisId = readString(record.hypothesisId);
  if (thesis === null || title === null || hypothesisId === null) return null;

  const status = (readString(record.status) ?? "exploring") as HypothesisStatus;
  const currentVersion = readNumber(record.currentVersion) ?? 1;
  const versionCount = readNumber(record.versionCount) ?? 0;
  const runCount = readNumber(record.runCount) ?? 0;
  const versionsShown = asArray(record.versions).length;
  const runsShown = asArray(record.runs).length;

  const windowNote =
    versionCount > versionsShown || runCount > runsShown
      ? `Showing ${versionsShown} of ${versionCount} versions and ${runsShown} of ${runCount} runs`
      : null;

  return {
    hypothesisId,
    title,
    statusLabel: `${describeHypothesisStatus(status)} · v${currentVersion}`,
    statusTone: STATUS_TONES[status] ?? "neutral",
    headline: describeThesis(thesis as unknown as TradingThesis),
    exits: describeExits((thesis.exits ?? {}) as TradingThesis["exits"]),
    currentNote: readString(record.currentNote) ?? "",
    runs: asArray(record.runs)
      .map(runLine)
      .filter((line): line is HypothesisRunLine => line !== null),
    validations: asArray(record.validations)
      .map(validationLine)
      .filter((line): line is HypothesisValidationLine => line !== null),
    conclusion: readString(record.conclusion),
    windowNote,
    rawJson: JSON.stringify(result, null, 2),
  };
}

/**
 * The result out of the tool call, through whichever shape the transport used.
 * Mirrors the validation card's reader; see its notes on the three shapes.
 */
function readHypothesisResult(toolData: unknown): unknown {
  const item = asRecord(toolData);
  if (item === null) return null;
  const name = typeof item.tool === "string" ? item.tool : item.toolName;
  if (typeof name !== "string" || !name.endsWith("trading_hypothesis")) return null;
  const result = asRecord(item.result);
  if (result === null) return null;

  const content = result.content;
  if (typeof content === "string") return parseJson(content);
  if (!Array.isArray(content)) return result;
  for (const entry of content) {
    const text = asRecord(entry)?.text;
    if (typeof text !== "string") continue;
    return parseJson(text);
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Truncated or a summary line. The ordinary tool row still renders it.
    return null;
  }
}
