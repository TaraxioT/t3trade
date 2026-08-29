/**
 * The hypothesis card, derived.
 *
 * The card is the only place the shape of a refinement is visible, so what is
 * pinned here is that it reads the lineage correctly: which version is
 * current, which runs belong to which version, and what the card says when it
 * is showing a window onto a longer history rather than the whole of it.
 */
import { describe, expect, it } from "vite-plus/test";

import { deriveHypothesisCard } from "./tradingHypothesis";

const thesis = {
  market: "ETH",
  interval: "5m",
  side: "long",
  entry: {
    predicates: [
      {
        left: { source: "price" },
        comparator: "crosses_above",
        right: { source: "constant", value: 100 },
      },
    ],
  },
  exits: { stop: { basis: "percent", value: 2 }, target: { basis: "percent", value: 3 } },
};

const hypothesis = (overrides: Record<string, unknown> = {}) => ({
  hypothesisId: "h-1",
  threadId: "t-1",
  title: "the ETH cross",
  status: "testing",
  conclusion: null,
  currentVersion: 2,
  thesis,
  currentNote: "one percent was inside the spread",
  createdAt: 1,
  updatedAt: 2,
  versions: [
    { version: 2, thesis, note: "widen the target", author: "agent", createdAt: 2 },
    { version: 1, thesis, note: "the idea as first written", author: "agent", createdAt: 1 },
  ],
  runs: [
    {
      runId: "r-2",
      version: 2,
      market: "ETH",
      interval: "5m",
      createdAt: 2,
      expectancyUsd: 1.25,
      tradesTaken: 25,
      winRatePercent: 52,
      maxDrawdownUsd: 8,
      totalNetUsd: 31.25,
      barsServed: 288,
      verdict: "positive_after_fees",
    },
    {
      runId: "r-1",
      version: 1,
      market: "ETH",
      interval: "5m",
      createdAt: 1,
      expectancyUsd: -0.4,
      tradesTaken: 30,
      winRatePercent: 44,
      maxDrawdownUsd: 12,
      totalNetUsd: -12,
      barsServed: 288,
      verdict: "negative_after_fees",
    },
  ],
  validations: [
    {
      validationId: "v-2",
      version: 2,
      market: "ETH",
      interval: "5m",
      status: "armed",
      armedAt: 2,
      expiresAt: 3,
      endedAt: null,
      tradesTaken: 4,
      expectancyUsd: 0.9,
      comparison: "too_few_trades",
    },
  ],
  versionCount: 2,
  runCount: 2,
  ...overrides,
});

const call = (record: unknown) => ({
  tool: "mcp__t3-trade__trading_hypothesis",
  result: { content: JSON.stringify({ hypothesis: record, outcome: "…" }) },
});

describe("deriveHypothesisCard", () => {
  it("reads the title, the status with its version, and the current rule", () => {
    const card = deriveHypothesisCard(call(hypothesis()))!;
    expect(card.title).toBe("the ETH cross");
    expect(card.statusLabel).toBe("Testing · v2");
    expect(card.headline).toContain("Buy ETH 5m when price crosses above 100");
    expect(card.exits).toEqual(["stop at 2% of entry", "target at 3% of entry"]);
    expect(card.currentNote).toBe("one percent was inside the spread");
  });

  it("keeps each run beside the version it measured, and colours it", () => {
    const card = deriveHypothesisCard(call(hypothesis()))!;
    expect(card.runs.map((run) => run.versionLabel)).toEqual(["v2", "v1"]);
    expect(card.runs[0]?.tone).toBe("positive");
    expect(card.runs[1]?.tone).toBe("negative");
    expect(card.runs[0]?.detail).toBe("25 trades · 52.0% hit rate · $8.00 worst drawdown");
    expect(card.runs[1]?.verdictLabel).toBe("Negative after fees");
  });

  it("never colours a figure the engine refused to grade", () => {
    const card = deriveHypothesisCard(
      call(
        hypothesis({
          runs: [{ ...hypothesis().runs[0], verdict: "insufficient_sample" }],
        }),
      ),
    )!;
    expect(card.runs[0]?.tone).toBe("neutral");
    expect(card.validations[0]?.tone).toBe("neutral");
  });

  it("says when it is showing a window onto a longer history", () => {
    expect(deriveHypothesisCard(call(hypothesis()))!.windowNote).toBeNull();
    const capped = deriveHypothesisCard(call(hypothesis({ versionCount: 30, runCount: 29 })))!;
    expect(capped.windowNote).toBe("Showing 2 of 30 versions and 2 of 29 runs");
  });

  it("shows the conclusion once there is one", () => {
    const card = deriveHypothesisCard(
      call(
        hypothesis({
          status: "unsupported",
          conclusion: "negative after fees on every window tested",
        }),
      ),
    )!;
    expect(card.conclusion).toBe("negative after fees on every window tested");
    // An idea proven wrong is a result, not a loss. It is never red.
    expect(card.statusTone).toBe("neutral");
    expect(card.statusLabel).toBe("Not supported · v2");
  });

  it("falls through for a list, a menu call, or another tool", () => {
    expect(
      deriveHypothesisCard({
        tool: "trading_hypothesis",
        result: { content: JSON.stringify({ hypotheses: [] }) },
      }),
    ).toBeNull();
    expect(
      deriveHypothesisCard({
        tool: "trading_hypothesis",
        result: { content: JSON.stringify({ menu: "…" }) },
      }),
    ).toBeNull();
    expect(deriveHypothesisCard({ tool: "trading_validate", result: {} })).toBeNull();
    expect(deriveHypothesisCard(null)).toBeNull();
  });
});
