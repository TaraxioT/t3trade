/**
 * The chart RPC's entitlement rule, both shapes.
 *
 * The live chart and the post-mortem chart ask the same RPC for very different
 * things, and the rule that was written for the live one refuses every review
 * chart there is — a completed mission is terminal by definition, which is
 * exactly what makes it reviewable.
 */
import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { isChartReadEntitled } from "./chartReadEntitlement.ts";

const LIVE = { market: "ETH" };
const REVIEW = { market: "ETH", startTime: 1_000, endTime: 2_000 };

describe("isChartReadEntitled", () => {
  it("refuses a market with no mission at all", () => {
    expect(isChartReadEntitled(LIVE, [])).toBe(false);
    expect(isChartReadEntitled(REVIEW, [])).toBe(false);
  });

  it("refuses a market some OTHER mission is running", () => {
    const missions = [{ markets: ["BTC"], status: "position_open" }];
    expect(isChartReadEntitled(LIVE, missions)).toBe(false);
    expect(isChartReadEntitled(REVIEW, missions)).toBe(false);
  });

  it("serves a live read on a running mission", () => {
    expect(isChartReadEntitled(LIVE, [{ markets: ["ETH"], status: "position_open" }])).toBe(true);
  });

  it("refuses a live read once the mission is terminal", () => {
    expect(isChartReadEntitled(LIVE, [{ markets: ["ETH"], status: "completed" }])).toBe(false);
    expect(isChartReadEntitled(LIVE, [{ markets: ["ETH"], status: "revoked" }])).toBe(false);
  });

  // The whole point of the review shape: the mission whose chart is being
  // reviewed has finished, so a terminal status must not refuse the read.
  it("serves a windowed read on a terminal mission", () => {
    expect(isChartReadEntitled(REVIEW, [{ markets: ["ETH"], status: "completed" }])).toBe(true);
    expect(isChartReadEntitled(REVIEW, [{ markets: ["ETH"], status: "revoked" }])).toBe(true);
  });

  // Half a window is not a window: a caller that sends only one bound gets the
  // live rule, so the review relaxation cannot be reached by accident.
  it("treats a half-specified window as a live read", () => {
    const missions = [{ markets: ["ETH"], status: "completed" }];
    expect(isChartReadEntitled({ market: "ETH", startTime: 1_000 }, missions)).toBe(false);
    expect(isChartReadEntitled({ market: "ETH", endTime: 2_000 }, missions)).toBe(false);
  });

  // Final-form phase 6: the follow set entitles a chart with no mission
  // anywhere near it — watchlist, positions and armed watches are attention,
  // and attention is what the chart RPC serves.
  it("serves a followed market with no mission at all, both shapes", () => {
    expect(isChartReadEntitled(LIVE, [], ["ETH"])).toBe(true);
    expect(isChartReadEntitled(REVIEW, [], ["ETH"])).toBe(true);
  });

  // A mission holding a SET entitles every market in it, not just the first.
  it("serves a live read on any market a multi-market mission holds", () => {
    const missions = [{ markets: ["ETH", "BTC"], status: "position_open" }];
    expect(isChartReadEntitled(LIVE, missions)).toBe(true);
    expect(isChartReadEntitled({ market: "BTC" }, missions)).toBe(true);
    expect(isChartReadEntitled({ market: "SOL" }, missions)).toBe(false);
  });

  it("does not let one followed market entitle another", () => {
    expect(isChartReadEntitled(LIVE, [], ["BTC"])).toBe(false);
    expect(isChartReadEntitled(REVIEW, [], ["BTC"])).toBe(false);
  });

  // A terminal mission refuses the live shape, but the market being followed
  // still serves it: the two entitlements are independent.
  it("follow set entitles a live read even where the mission rule refuses", () => {
    const missions = [{ markets: ["ETH"], status: "completed" }];
    expect(isChartReadEntitled(LIVE, missions, ["ETH"])).toBe(true);
  });
});
