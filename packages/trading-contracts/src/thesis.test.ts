/**
 * The thesis shape, and the refusals it answers with.
 *
 * The point of the validation living here rather than in the schema is that a
 * model can act on `"target: R is a multiple of the stop distance, so a target
 * in R needs a stop to measure against"` and cannot act on a decode failure.
 * These pin that each refusal names the field and says what to do.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  describeCondition,
  describeExits,
  describeThesis,
  THESIS_MAX_PREDICATES,
  thesisEntryPriceLevels,
  thesisIndicators,
  validateThesis,
  type TradingThesis,
} from "./thesis.ts";

/** The sentence from the brief: RSI(14) under 30 with price above EMA(50). */
const meanReversion: TradingThesis = {
  market: "ETH",
  interval: "15m",
  side: "long",
  entry: {
    match: "all",
    predicates: [
      {
        left: { source: "indicator", indicator: "rsi", period: 14 },
        comparator: "below",
        right: { source: "constant", value: 30 },
      },
      {
        left: { source: "price" },
        comparator: "above",
        right: { source: "indicator", indicator: "ema", period: 50 },
      },
    ],
  },
  exits: {
    stop: { basis: "atr", multiple: 1.5, period: 14 },
    target: { basis: "r", multiple: 2 },
    maxHoldBars: 48,
  },
};

describe("validateThesis", () => {
  it("accepts the smallest schema that expresses the brief's own example", () => {
    expect(validateThesis(meanReversion)).toBeNull();
    expect(describeThesis(meanReversion)).toBe(
      "Buy ETH 15m when RSI(14) is below 30 and price is above EMA(50)",
    );
    expect(describeExits(meanReversion.exits)).toEqual([
      "stop at 1.5x ATR(14)",
      "target at 2R",
      "close after 48 bars",
    ]);
  });

  it("refuses a thesis with no way out", () => {
    const refusal = validateThesis({ ...meanReversion, exits: {} });
    expect(refusal).toContain("at least one");
    expect(refusal).toContain("cannot be scored");
    // Refusals are read by a person through the model. No em dashes.
    expect(refusal).not.toContain("—");
  });

  it("refuses an R target with no stop to measure it against", () => {
    const refusal = validateThesis({
      ...meanReversion,
      exits: { target: { basis: "r", multiple: 2 } },
    });
    expect(refusal).toContain("target");
    expect(refusal).toContain("needs a stop");
  });

  it("refuses a stop measured in R, which is circular", () => {
    const refusal = validateThesis({
      ...meanReversion,
      exits: { stop: { basis: "r", multiple: 1 }, maxHoldBars: 10 },
    });
    expect(refusal).toContain("stop");
  });

  it("refuses a component the indicator does not report", () => {
    const refusal = validateThesis({
      ...meanReversion,
      entry: {
        predicates: [
          {
            left: { source: "indicator", indicator: "rsi", period: 14, component: "signal" },
            comparator: "below",
            right: { source: "constant", value: 30 },
          },
        ],
      },
    });
    expect(refusal).toContain("rsi reports value, not signal");
  });

  it("accepts the components macd and bollinger do report", () => {
    expect(
      validateThesis({
        ...meanReversion,
        entry: {
          predicates: [
            {
              left: { source: "indicator", indicator: "macd" },
              comparator: "crosses_above",
              right: { source: "indicator", indicator: "macd", component: "signal" },
            },
            {
              left: { source: "price" },
              comparator: "below",
              right: { source: "indicator", indicator: "bollinger", component: "lower" },
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("refuses a comparison that never reads the market", () => {
    const refusal = validateThesis({
      ...meanReversion,
      entry: {
        predicates: [
          {
            left: { source: "constant", value: 1 },
            comparator: "above",
            right: { source: "constant", value: 0 },
          },
        ],
      },
    });
    expect(refusal).toContain("never reads the market");
  });

  it("caps the boolean combination at one level and a handful of terms", () => {
    const predicate = meanReversion.entry.predicates[0];
    const refusal = validateThesis({
      ...meanReversion,
      entry: {
        match: "any",
        predicates: Array.from(
          { length: THESIS_MAX_PREDICATES + 1 },
          () => predicate,
        ) as typeof meanReversion.entry.predicates,
      },
    });
    expect(refusal).toContain("Split the idea into two theses");
  });

  it("refuses a period no indicator could be computed over", () => {
    const refusal = validateThesis({
      ...meanReversion,
      entry: {
        predicates: [
          {
            left: { source: "indicator", indicator: "ema", period: 0 },
            comparator: "above",
            right: { source: "price" },
          },
        ],
      },
    });
    expect(refusal).toContain("only vwap reads a period of 0");
  });
});

describe("thesisIndicators", () => {
  it("collects every indicator the rules and the exits between them need", () => {
    expect(thesisIndicators(meanReversion)).toEqual([
      { kind: "rsi", period: 14 },
      { kind: "ema", period: 50 },
      // The ATR stop needs one too, and it is not named in any comparison.
      { kind: "atr", period: 14 },
    ]);
  });

  it("deduplicates a reading two rules share", () => {
    expect(
      thesisIndicators({
        ...meanReversion,
        exits: {
          opposite: {
            predicates: [
              {
                left: { source: "indicator", indicator: "rsi", period: 14 },
                comparator: "above",
                right: { source: "constant", value: 70 },
              },
            ],
          },
        },
      }),
    ).toEqual([
      { kind: "rsi", period: 14 },
      { kind: "ema", period: 50 },
    ]);
  });
});

describe("prose", () => {
  it("says the condition in words a trader uses, with no enum tokens in it", () => {
    const line = describeCondition({
      match: "any",
      predicates: [
        {
          left: { source: "indicator", indicator: "macd" },
          comparator: "crosses_below",
          right: { source: "indicator", indicator: "macd", component: "signal" },
        },
        {
          left: { source: "price", field: "low" },
          comparator: "below",
          right: { source: "indicator", indicator: "bollinger", period: 20, component: "lower" },
        },
      ],
    });
    expect(line).toBe(
      "MACD crosses below MACD signal or bar low is below Bollinger(20) lower band",
    );
    expect(line).not.toContain("_");
  });
});

describe("thesisEntryPriceLevels", () => {
  const thesis = (predicates: ReadonlyArray<unknown>) =>
    ({
      market: "ETH",
      interval: "5m",
      side: "long",
      entry: { predicates },
      exits: { stop: { basis: "percent", value: 1 } },
    }) as never;

  it("reads a price against a constant, on the side the rule fires", () => {
    expect(
      thesisEntryPriceLevels(
        thesis([
          {
            left: { source: "price", field: "close" },
            comparator: "above",
            right: { source: "constant", value: 3_900 },
          },
        ]),
      ),
    ).toEqual([{ price: 3_900, direction: "above" }]);
  });

  it("treats a cross as the side it crosses to", () => {
    expect(
      thesisEntryPriceLevels(
        thesis([
          {
            left: { source: "price" },
            comparator: "crosses_below",
            right: { source: "constant", value: 3_000 },
          },
        ]),
      ),
    ).toEqual([{ price: 3_000, direction: "below" }]);
  });

  it("reads the same rule written backwards as the same rule", () => {
    // "3900 below close" is "close above 3900": the comparator describes where
    // the NUMBER sits, so price sits on the other side of it.
    expect(
      thesisEntryPriceLevels(
        thesis([
          {
            left: { source: "constant", value: 3_900 },
            comparator: "below",
            right: { source: "price" },
          },
        ]),
      ),
    ).toEqual([{ price: 3_900, direction: "above" }]);
  });

  it("says nothing about a rule with no constant in it", () => {
    expect(
      thesisEntryPriceLevels(
        thesis([
          {
            left: { source: "price" },
            comparator: "above",
            right: { source: "indicator", indicator: "ema", period: 50 },
          },
          {
            left: { source: "indicator", indicator: "rsi" },
            comparator: "below",
            right: { source: "constant", value: 30 },
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("names one level once, however many predicates name it", () => {
    const predicate = {
      left: { source: "price" },
      comparator: "above",
      right: { source: "constant", value: 3_900 },
    };
    expect(thesisEntryPriceLevels(thesis([predicate, predicate]))).toHaveLength(1);
  });
});
