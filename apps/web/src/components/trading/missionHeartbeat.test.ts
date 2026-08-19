import { describe, expect, it } from "vite-plus/test";

import {
  composeHeartbeatSentence,
  firstClause,
  splitNumericRuns,
  type HeartbeatInput,
} from "./missionHeartbeat";

// A fixed clock, so the clock-time clauses assert against stable strings.
// 14:32 in the test runner's locale is computed, not assumed: toLocaleTimeString
// renders 2-digit hours, and the assertions build the expected time the same
// way the code under test does.
const NOW = Date.UTC(2026, 0, 15, 14, 32, 0);
const at = (hhmm: string): number => Date.parse(`2026-01-15T${hhmm}:00`);

const base: HeartbeatInput = {
  state: "armed",
  market: "ETH",
  watch: null,
  nextCheckInAt: at("14:32"),
  position: null,
  because: null,
  blockedReason: null,
  nowMillis: NOW,
};

const clock = (millis: number): string =>
  new Date(millis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("composeHeartbeatSentence", () => {
  it("flat and armed: watches a candle-close level with the watch's own interval", () => {
    const sentence = composeHeartbeatSentence({
      ...base,
      watch: { kind: "candle_close", direction: "above", price: 4290, intervalLabel: "5m" },
    });
    expect(sentence).toBe(
      `Watching ETH · will act if a 5m candle closes above 4,290 · next check-in ${clock(at("14:32"))}`,
    );
  });

  it("renders a 15m interval from the watch data, not a hard-coded bar size", () => {
    const sentence = composeHeartbeatSentence({
      ...base,
      watch: { kind: "candle_close", direction: "below", price: 4105.5, intervalLabel: "15m" },
    });
    expect(sentence).toContain("a 15m candle closes below 4,105.5");
  });

  it("armed on a price_cross watch speaks of a trade through the level", () => {
    const sentence = composeHeartbeatSentence({
      ...base,
      watch: { kind: "price_cross", direction: "above", price: 4290, intervalLabel: null },
    });
    expect(sentence).toBe(
      `Watching ETH · will act if ETH trades above 4,290 · next check-in ${clock(at("14:32"))}`,
    );
  });

  it("armed with no readable watch still says it is watching", () => {
    expect(composeHeartbeatSentence(base)).toBe(
      `Watching ETH · waiting on the plan's moment · next check-in ${clock(at("14:32"))}`,
    );
  });

  it("holding long states side, size, entry, pnl and the bracket", () => {
    const sentence = composeHeartbeatSentence({
      ...base,
      state: "holding",
      position: {
        size: 0.12,
        entryPrice: 4251,
        unrealisedPnl: 8.4,
        targetPrice: 4318,
        stopPrice: 4205,
      },
    });
    expect(sentence).toBe(
      "Long 0.12 ETH from 4,251 · up $8.40 · banking at 4,318, out below 4,205",
    );
  });

  it("holding short flips the out-clause and the pnl direction", () => {
    const sentence = composeHeartbeatSentence({
      ...base,
      state: "holding",
      position: {
        size: -0.5,
        entryPrice: 4300,
        unrealisedPnl: -3.2,
        targetPrice: 4250,
        stopPrice: 4340,
      },
    });
    expect(sentence).toBe(
      "Short 0.5 ETH from 4,300 · down $3.20 · banking at 4,250, out above 4,340",
    );
  });

  it("holding omits the clauses the projection does not state", () => {
    const sentence = composeHeartbeatSentence({
      ...base,
      state: "holding",
      position: {
        size: 0.12,
        entryPrice: null,
        unrealisedPnl: 0,
        targetPrice: null,
        stopPrice: null,
      },
    });
    expect(sentence).toBe("Long 0.12 ETH · flat");
  });

  it("stand-aside quotes the first clause and re-reads at a clock time", () => {
    const sentence = composeHeartbeatSentence({
      ...base,
      state: "stand_aside",
      because:
        "The 1m structure is a coin flip after the news; a 15m close would re-rate the whole range. Waiting for one.",
    });
    expect(sentence).toBe(
      `Standing aside: The 1m structure is a coin flip after the news · re-reading at ${clock(at("14:32"))}`,
    );
  });

  it("stand-aside with no narrative still says why-shaped things", () => {
    expect(composeHeartbeatSentence({ ...base, state: "stand_aside", because: null })).toBe(
      `Standing aside · re-reading at ${clock(at("14:32"))}`,
    );
  });

  it("stand-aside swaps the because's em-dashes rather than quoting them", () => {
    const sentence = composeHeartbeatSentence({
      ...base,
      state: "stand_aside",
      because:
        "The 1m structure is a coin flip — the news cut both ways — so a close would re-rate it. Waiting.",
    });
    expect(sentence).not.toContain("—");
    expect(sentence).toContain("The 1m structure is a coin flip · the news cut both ways");
  });

  it("blocked states the reason and the way back", () => {
    expect(
      composeHeartbeatSentence({ ...base, state: "blocked", blockedReason: "risk limits" }),
    ).toBe("Standing down: risk limits · nothing trades until it is resumed");
    expect(composeHeartbeatSentence({ ...base, state: "blocked", blockedReason: null })).toBe(
      "Standing down: paused by the operator · nothing trades until it is resumed",
    );
  });

  it("planning says it is reading the market", () => {
    expect(composeHeartbeatSentence({ ...base, state: "planning", nextCheckInAt: null })).toBe(
      "Reading ETH · first plan pending",
    );
  });

  it("armed without a check-in drops the clause rather than inventing a time", () => {
    const sentence = composeHeartbeatSentence({
      ...base,
      watch: { kind: "price_cross", direction: "below", price: 4200, intervalLabel: null },
      nextCheckInAt: null,
    });
    expect(sentence).toBe("Watching ETH · will act if ETH trades below 4,200");
  });

  it("never contains an em-dash", () => {
    const sentences = [
      composeHeartbeatSentence(base),
      composeHeartbeatSentence({
        ...base,
        state: "holding",
        position: {
          size: 1,
          entryPrice: 100,
          unrealisedPnl: 1,
          targetPrice: 110,
          stopPrice: 95,
        },
      }),
      composeHeartbeatSentence({ ...base, state: "stand_aside", because: "a. b. c." }),
      composeHeartbeatSentence({ ...base, state: "blocked", blockedReason: "x" }),
    ];
    for (const sentence of sentences) expect(sentence).not.toContain("—");
  });
});

describe("firstClause", () => {
  it("takes everything before the first period", () => {
    expect(firstClause("One. Two.")).toBe("One");
  });

  it("splits on semicolons too", () => {
    expect(firstClause("One; two")).toBe("One");
  });

  it("bounds a run-on clause with an ellipsis", () => {
    const clause = firstClause("x".repeat(120));
    expect(clause).toHaveLength(90);
    expect(clause!.endsWith("…")).toBe(true);
  });

  it("returns null for blank input", () => {
    expect(firstClause(null)).toBeNull();
    expect(firstClause("   ")).toBeNull();
  });
});

describe("splitNumericRuns", () => {
  it("wraps prices, sizes and percents in mono runs", () => {
    expect(splitNumericRuns("Long 0.12 ETH from 4,251 · up $8.40")).toEqual([
      { text: "Long ", mono: false },
      { text: "0.12", mono: true },
      { text: " ETH from ", mono: false },
      { text: "4,251", mono: true },
      { text: " · up $", mono: false },
      { text: "8.40", mono: true },
    ]);
  });

  it("keeps clock times whole, colon included", () => {
    expect(splitNumericRuns("next check-in 14:32")).toEqual([
      { text: "next check-in ", mono: false },
      { text: "14:32", mono: true },
    ]);
  });

  it("leaves a following unit in prose", () => {
    expect(splitNumericRuns("a 5m candle")).toEqual([
      { text: "a ", mono: false },
      { text: "5", mono: true },
      { text: "m candle", mono: false },
    ]);
  });

  it("loses nothing: the parts rejoin into the sentence", () => {
    for (const sentence of [
      "Watching ETH · will act if a 15m candle closes below 4,105.5",
      "Standing down: paused by the operator · nothing trades until it is resumed",
      "Reading ETH · first plan pending",
    ]) {
      expect(
        splitNumericRuns(sentence)
          .map((part) => part.text)
          .join(""),
      ).toBe(sentence);
    }
  });

  it("a sentence with no numbers is one prose part", () => {
    expect(splitNumericRuns("Standing aside")).toEqual([{ text: "Standing aside", mono: false }]);
  });
});
