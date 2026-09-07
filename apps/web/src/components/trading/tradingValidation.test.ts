/**
 * The validation card's derivation.
 *
 * The rules that matter are about honesty rather than layout: a figure under
 * the sample floor must not be coloured as a finding, an open paper position
 * must be named rather than folded into the totals, and a payload that is not
 * a report must fall through to the ordinary tool row instead of rendering an
 * empty card.
 */
import { describe, expect, it } from "vite-plus/test";

import { deriveValidationCard } from "./tradingValidation";

const thesis = {
  market: "ETH",
  interval: "5m",
  side: "long",
  entry: {
    predicates: [
      {
        left: { source: "indicator", indicator: "rsi", period: 14 },
        comparator: "below",
        right: { source: "constant", value: 30 },
      },
    ],
  },
  exits: { stop: { basis: "percent", value: 1 }, target: { basis: "r", multiple: 2 } },
};

const stats = (over: Record<string, number> = {}) => ({
  setupsFound: 40,
  tradesTaken: 30,
  setupsUnpriced: 0,
  wins: 18,
  losses: 12,
  breakEven: 0,
  winRatePercent: 60,
  averageWinUsd: 8,
  averageLossUsd: -5,
  expectancyUsd: 1.2,
  totalGrossUsd: 60,
  totalFeesUsd: 24,
  totalFundingUsd: 0,
  totalNetUsd: 36,
  maxDrawdownUsd: 14,
  timeInMarketPercent: 22,
  buyAndHoldNetUsd: 0,
  buyAndHoldReturnPercent: 0,
  ...over,
});

const call = (report: unknown) => ({
  toolName: "mcp__t3-trade__trading_validate",
  result: { content: JSON.stringify({ report }) },
});

const report = (over: Record<string, unknown> = {}) => ({
  validationId: "v1",
  thesis,
  headline: "The 5m RSI fade",
  status: "armed",
  armedAt: 1_000,
  expiresAt: 1_000 + 14 * 24 * 60 * 60 * 1_000,
  endedAt: null,
  endReason: null,
  notionalUsd: 1_000,
  barsWatched: 4_032,
  stats: stats(),
  openTrade: null,
  baselineExpectancyUsd: 1.1,
  baselineWinRatePercent: 58,
  baselineTradesTaken: 120,
  comparison: "tracking",
  verdictReason: "Forward is tracking the backtest within the noise of this sample.",
  paperOnly: true,
  ...over,
});

describe("deriveValidationCard", () => {
  it("reads the report and says paper on the status line", () => {
    const card = deriveValidationCard(call(report()));
    expect(card).not.toBeNull();
    expect(card?.headline).toBe("The 5m RSI fade");
    // "Paper" must be in the reader's path, not a footnote — every figure on
    // this card is money that was neither made nor lost.
    expect(card?.statusLine).toContain("paper");
    expect(card?.comparisonLabel).toBe("Tracking the backtest");
    expect(card?.expectancy.value).toContain("$1.20");
    expect(card?.expectancy.tone).toBe("positive");
  });

  it("does not colour a figure under the sample floor as a finding", () => {
    // Eleven profitable paper trades is not a result, and a green number says
    // it is. The figure is still printed.
    const card = deriveValidationCard(
      call(report({ comparison: "too_few_trades", stats: stats({ tradesTaken: 11 }) })),
    );
    expect(card?.expectancy.tone).toBe("neutral");
    expect(card?.expectancy.value).toContain("$1.20");
    expect(card?.comparisonLabel).toBe("Too few trades for a verdict");
  });

  it("names an open paper position rather than folding it into the totals", () => {
    const card = deriveValidationCard(
      call(
        report({
          openTrade: {
            id: "t9",
            entryTime: 5_000,
            entryPrice: 3_012.5,
            signalTime: 4_700,
            stopPrice: 2_982,
            targetPrice: 3_073,
            exitTime: null,
            exitPrice: null,
            exitReason: null,
            barsHeld: 3,
            grossUsd: null,
            feesUsd: null,
            fundingUsd: null,
            netUsd: null,
            adverseExcursionUsd: null,
          },
        }),
      ),
    );
    expect(card?.openLine).toContain("open");
    // The price the trade was actually taken at, not a rounded dollar figure.
    expect(card?.openLine).toContain("3,012.5");
  });

  it("carries the backtest's own expectation onto the card when there is one", () => {
    const card = deriveValidationCard(call(report()));
    const baseline = card?.stats.find((stat) => stat.label === "Backtest expected");
    expect(baseline?.value).toContain("$1.10");
  });

  it("does not word or colour tracking a losing baseline as success", () => {
    // The engine says tracking a backtest that loses money is replication,
    // not a result; the card must not undo that with a green chip.
    const card = deriveValidationCard(
      call(
        report({
          baselineExpectancyUsd: -1.1,
          stats: stats({ expectancyUsd: -1.05, totalNetUsd: -31.5 }),
          verdictReason:
            "Forward is tracking the backtest within a heuristic band. Both figures lose money after fees.",
        }),
      ),
    );
    expect(card?.comparisonLabel).toBe("Tracking a losing backtest");
    expect(card?.comparisonTone).toBe("neutral");
  });

  it("names the run a recorded baseline came from, and says when none was recorded", () => {
    const withSource = deriveValidationCard(
      call(
        report({
          baselineSource: {
            runId: "0f4c1a2b-1111-2222-3333-444444444444",
            digest: "9a8b7c6d5e4f3021",
            computedAt: 2_000,
          },
        }),
      ),
    );
    const provenance = withSource?.stats.find((stat) => stat.label === "Baseline provenance");
    expect(provenance?.value).toContain("run 0f4c1a2b");
    expect(provenance?.value).toContain("digest 9a8b7c6d");
    expect(provenance?.tone).toBe("neutral");

    // A baseline armed before provenance was kept: the absence is stated,
    // never papered over with a run id guessed from anything else.
    const legacy = deriveValidationCard(call(report()));
    const legacyProvenance = legacy?.stats.find((stat) => stat.label === "Baseline provenance");
    expect(legacyProvenance?.value).toBe("not recorded");
  });

  it("omits the comparison row when nothing was recorded to compare against", () => {
    const card = deriveValidationCard(
      call(report({ baselineExpectancyUsd: null, comparison: "no_baseline" })),
    );
    expect(card?.stats.find((stat) => stat.label === "Backtest expected")).toBeUndefined();
    expect(card?.comparisonLabel).toBe("No backtest to compare against");
  });

  it("says what ended a finished validation", () => {
    const card = deriveValidationCard(
      call(report({ status: "ended", endReason: "expired", endedAt: 9_000 })),
    );
    expect(card?.statusLine).toContain("ran its course");
  });

  it("says a paused validation is paused", () => {
    const card = deriveValidationCard(call(report({ status: "paused" })));
    expect(card?.statusLine).toContain("Paused");
  });

  it("falls through to the ordinary tool row for a call with no report", () => {
    // The menu call, a `list`, and a refusal all carry no report. Rendering an
    // empty card for them would be worse than the row they already get.
    expect(
      deriveValidationCard({
        toolName: "trading_validate",
        result: { content: JSON.stringify({ menu: "arm a thesis…" }) },
      }),
    ).toBeNull();
    // A different tool entirely.
    expect(
      deriveValidationCard(call(report()) && { toolName: "trading_look", result: {} }),
    ).toBeNull();
    // A truncated result: the projection summarized it rather than keeping it.
    expect(
      deriveValidationCard({
        toolName: "trading_validate",
        result: { content: "Validated 30 pa…" },
      }),
    ).toBeNull();
  });

  it("reads the bare-object and array transport shapes as well as the string", () => {
    const payload = { report: report() };
    // What the handler returns before the transport touches it.
    expect(deriveValidationCard({ tool: "trading_validate", result: payload })?.headline).toBe(
      "The 5m RSI fade",
    );
    // The raw MCP transport shape.
    expect(
      deriveValidationCard({
        tool: "trading_validate",
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      })?.headline,
    ).toBe("The 5m RSI fade");
  });
});
