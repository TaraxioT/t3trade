/**
 * What the ideas panel says about a row, given the numbers it was sent.
 *
 * The distinctions worth pinning are the ones between an absence and a zero:
 * a run with no settled trade has no expectancy, and one whose runs have ended
 * has no clock. Both render as $0.00 and "0 days left" if nobody says so.
 */
import { describe, expect, it } from "vite-plus/test";

import { ideaRowView, ideaStatusSentence, timeLeftLabel } from "./tradingIdeaPresentation";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const row = (over: Record<string, unknown> = {}) =>
  ({
    kind: "validation",
    id: "v1",
    title: "The 5m fade",
    market: "ETH",
    interval: "5m",
    status: "armed",
    expectancyUsd: 1.25,
    trades: 12,
    expiresAt: 10 * DAY,
    comparison: "tracking",
    threadId: "t1",
    hypothesisId: null,
    ...over,
  }) as Parameters<typeof ideaRowView>[0];

describe("timeLeftLabel", () => {
  it("counts days down to one, then hours, then says finishing", () => {
    expect(timeLeftLabel(4 * DAY, 0)).toBe("4 days left");
    expect(timeLeftLabel(6 * HOUR, 0)).toBe("6 hours left");
    // Singular at one, in both units. The panel rounds to days for anything
    // over a day, so a five-day run really does print "1 days left" a day
    // before it ends unless this is here.
    expect(timeLeftLabel(DAY, 0)).toBe("1 day left");
    // Never "0 hours left": under an hour there is still time on the clock.
    expect(timeLeftLabel(30_000, 0)).toBe("1 hour left");
    expect(timeLeftLabel(0, 0)).toBe("finishing");
    expect(timeLeftLabel(-1, 0)).toBe("finishing");
  });

  it("has nothing to say about a row with no clock", () => {
    expect(timeLeftLabel(null, 0)).toBeNull();
  });
});

describe("ideaRowView", () => {
  it("states the run, its market and how it is doing", () => {
    expect(ideaRowView(row(), 3 * DAY)).toMatchObject({
      marketLine: "ETH · 5m",
      statusLabel: "Validating on paper",
      timeLeft: "7 days left",
      expectancyLabel: "+$1.25 a trade",
      expectancyTone: "positive",
      tradesLabel: "12 paper trades",
      comparisonLabel: "tracking",
      comparisonTone: "positive",
    });
  });

  it("separates no expectancy from an expectancy of nothing", () => {
    expect(ideaRowView(row({ expectancyUsd: null, trades: 0 }), 0)).toMatchObject({
      expectancyLabel: "no expectancy yet",
      expectancyTone: "neutral",
      tradesLabel: "no paper trades yet",
    });
    expect(ideaRowView(row({ expectancyUsd: 0, trades: 3 }), 0)).toMatchObject({
      expectancyLabel: "$0.00 a trade",
      expectancyTone: "neutral",
    });
  });

  it("counts one trade in the singular", () => {
    expect(ideaRowView(row({ trades: 1 }), 0).tradesLabel).toBe("1 paper trade");
  });

  it("does not say a testing idea is validating, and gives it no countdown", () => {
    expect(ideaRowView(row({ status: "testing", expiresAt: null }), 0)).toMatchObject({
      statusLabel: "Testing — no run on the clock",
      timeLeft: null,
    });
  });

  it("tones a losing run negative and an unverdicted one neutral", () => {
    expect(ideaRowView(row({ expectancyUsd: -0.8 }), 0).expectancyTone).toBe("negative");
    expect(ideaRowView(row({ comparison: "worse_than_backtest" }), 0).comparisonTone).toBe(
      "negative",
    );
    expect(ideaRowView(row({ comparison: "no_baseline" }), 0).comparisonTone).toBe("neutral");
  });

  it("does not colour tracking of a losing ledger as success", () => {
    // The row carries no baseline figure, so "tracking" is judged against the
    // forward expectancy it does carry: matching a losing backtest while the
    // paper ledger loses money is replication, not a green chip.
    const view = ideaRowView(row({ expectancyUsd: -1.05 }), 0);
    expect(view.comparisonLabel).toBe("tracking");
    expect(view.comparisonTone).toBe("neutral");
    // A tracking run whose ledger wins keeps the positive chip.
    expect(ideaRowView(row({ expectancyUsd: 1.25 }), 0).comparisonTone).toBe("positive");
  });

  it("asks its thread a question that names the idea and the series", () => {
    expect(ideaStatusSentence(ideaRowView(row(), 0))).toBe(
      'How is "The 5m fade" doing on ETH · 5m, and what does the paper record say so far?',
    );
  });
});
