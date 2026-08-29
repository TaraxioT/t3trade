/**
 * The thesis comparison, which is the whole of the run-to-version link.
 *
 * A run is filed against a version only when the thesis it measured is that
 * version's thesis. Everything about the honesty of a hypothesis record rests
 * on this function saying yes to two spellings of the same idea and no to two
 * different ideas, however small the difference.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  describeHypothesis,
  describeHypothesisStatus,
  renderTradingHypothesisMenu,
  thesesMatch,
} from "./hypothesis.ts";
import type { TradingThesis } from "./thesis.ts";

const base: TradingThesis = {
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
  exits: { stop: { basis: "percent", value: 2 }, target: { basis: "r", multiple: 2 } },
};

describe("thesesMatch", () => {
  it("is true for the same idea written in a different key order", () => {
    const reordered = {
      side: base.side,
      exits: { target: base.exits.target, stop: base.exits.stop },
      interval: base.interval,
      entry: {
        predicates: [
          {
            comparator: "below",
            right: { value: 30, source: "constant" },
            left: { period: 14, indicator: "rsi", source: "indicator" },
          },
        ],
      },
      market: base.market,
    } as unknown as TradingThesis;
    expect(thesesMatch(base, reordered)).toBe(true);
  });

  it("treats an optional field written as undefined as absent", () => {
    // A model's tool arguments routinely carry `match: undefined` where a
    // decoded row simply omits the key. That is the same thesis.
    const spelled = {
      ...base,
      entry: { match: undefined, predicates: base.entry.predicates },
    } as unknown as TradingThesis;
    expect(thesesMatch(base, spelled)).toBe(true);
  });

  it("is false for a changed period, comparator or distance", () => {
    expect(
      thesesMatch(base, {
        ...base,
        entry: {
          predicates: [
            {
              left: { source: "indicator", indicator: "rsi", period: 21 },
              comparator: "below",
              right: { source: "constant", value: 30 },
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      thesesMatch(base, {
        ...base,
        entry: {
          predicates: [
            {
              left: { source: "indicator", indicator: "rsi", period: 14 },
              comparator: "crosses_below",
              right: { source: "constant", value: 30 },
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      thesesMatch(base, {
        ...base,
        exits: { ...base.exits, stop: { basis: "percent", value: 2.5 } },
      }),
    ).toBe(false);
  });

  it("is false when an optional field is genuinely present on one side", () => {
    expect(thesesMatch(base, { ...base, exits: { ...base.exits, maxHoldBars: 48 } })).toBe(false);
  });
});

describe("prose", () => {
  it("says the status in words, never the token", () => {
    expect(describeHypothesisStatus("unsupported")).toBe("Not supported");
    expect(describeHypothesis({ thesis: base, currentVersion: 3, status: "testing" })).toContain(
      "Testing · v3 · ",
    );
  });

  it("the menu names the supersede rule and says nothing is traded", () => {
    const menu = renderTradingHypothesisMenu();
    expect(menu).toContain("supersedes");
    expect(menu).toContain("nothing here places an order");
    // The vocabulary rides one call, not every turn: keep it short enough to
    // stay a menu rather than a second system prompt.
    expect(menu.length).toBeLessThan(900);
  });
});
