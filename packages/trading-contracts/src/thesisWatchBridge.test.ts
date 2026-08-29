/**
 * The expressibility matrix, both ways.
 *
 * Every predicate shape the grammar can write is either armed as a watch or
 * named in a refusal sentence, and the test asserts which - because the whole
 * value of the bridge is that a user is never left guessing whether the alert
 * they asked for exists.
 */
import { describe, expect, it } from "@effect/vitest";

import type { ThesisCondition, TradingThesis } from "./thesis.ts";
import { describeSetupAlerts, thesisSetupAlerts } from "./thesisWatchBridge.ts";

const thesisWith = (
  entry: ThesisCondition,
  extra?: Partial<Pick<TradingThesis, "after" | "interval">>,
): TradingThesis => ({
  market: "ETH",
  interval: extra?.interval ?? "5m",
  side: "long",
  entry,
  ...(extra?.after === undefined ? {} : { after: extra.after }),
  exits: { maxHoldBars: 20 },
});

const one = (predicate: ThesisCondition["predicates"][number]): ThesisCondition => ({
  predicates: [predicate],
});

describe("what the watch vocabulary can express", () => {
  it("turns a price level into a close-confirmed price watch on the thesis's own interval", () => {
    const alerts = thesisSetupAlerts(
      thesisWith(
        one({
          left: { source: "price" },
          comparator: "crosses_above",
          right: { source: "constant", value: 3_900 },
        }),
      ),
    );
    expect(alerts.inexpressible).toEqual([]);
    expect(alerts.conditions).toEqual([
      {
        kind: "price",
        market: "ETH",
        direction: "above",
        price: 3_900,
        confirm: "close",
        interval: "5m",
      },
    ]);
  });

  it("reads the operand order rather than assuming it", () => {
    // "3900 below price" is "price above 3900" written backwards. The
    // comparator describes where the NUMBER sits, so the watch fires above.
    const alerts = thesisSetupAlerts(
      thesisWith(
        one({
          left: { source: "constant", value: 3_900 },
          comparator: "below",
          right: { source: "price" },
        }),
      ),
    );
    expect(alerts.conditions[0]).toMatchObject({ kind: "price", direction: "above", price: 3_900 });
  });

  it("passes a funding threshold across unchanged, units and sign included", () => {
    const alerts = thesisSetupAlerts(
      thesisWith(
        one({
          left: { source: "metric", metric: "funding_rate_8h" },
          comparator: "below",
          right: { source: "constant", value: -0.0001 },
        }),
      ),
    );
    expect(alerts.inexpressible).toEqual([]);
    expect(alerts.conditions).toEqual([
      {
        kind: "metric",
        market: "ETH",
        metric: "funding_rate_8h",
        direction: "below",
        value: -0.0001,
      },
    ]);
  });

  it("arms a volume pace watch, which the alert layer measures the same way", () => {
    const alerts = thesisSetupAlerts(
      thesisWith(
        one({
          left: { source: "metric", metric: "volume_ratio" },
          comparator: "above",
          right: { source: "constant", value: 2 },
        }),
      ),
    );
    expect(alerts.inexpressible).toEqual([]);
    expect(alerts.conditions).toEqual([
      {
        kind: "metric",
        market: "ETH",
        metric: "volume_ratio",
        direction: "above",
        value: 2,
        interval: "5m",
      },
    ]);
  });
});

describe("what it cannot, and says so", () => {
  const refusalFor = (entry: ThesisCondition, extra?: Parameters<typeof thesisWith>[1]) =>
    thesisSetupAlerts(thesisWith(entry, extra)).inexpressible;

  it("refuses an indicator reading, naming the predicate", () => {
    const [sentence, ...rest] = refusalFor(
      one({
        left: { source: "price" },
        comparator: "crosses_above",
        right: { source: "indicator", indicator: "ema", period: 50 },
      }),
    );
    expect(rest).toEqual([]);
    expect(sentence).toContain("EMA(50)");
    expect(sentence, "it must say what is still watching it").toContain("paper validation");
  });

  it("refuses a raw bar volume, which the alert layer has no reading for", () => {
    const [sentence] = refusalFor(
      one({
        left: { source: "metric", metric: "volume" },
        comparator: "above",
        right: { source: "constant", value: 1_000 },
      }),
    );
    expect(sentence).toContain("bar volume");
    expect(sentence).toContain("24h notional");
  });

  it("refuses two moving readings compared against each other", () => {
    const [sentence] = refusalFor(
      one({
        left: { source: "indicator", indicator: "ema", period: 20 },
        comparator: "crosses_above",
        right: { source: "indicator", indicator: "ema", period: 50 },
      }),
    );
    expect(sentence).toContain("two moving readings");
  });

  it("refuses a price level on an interval no alert can close a bar on", () => {
    const [sentence] = refusalFor(
      one({
        left: { source: "price" },
        comparator: "above",
        right: { source: "constant", value: 3_900 },
      }),
      { interval: "1d" },
    );
    expect(sentence).toContain("1d");
    expect(sentence).toContain("1h");
  });

  it("drops the sequence and names it, while still arming the legs it can", () => {
    const alerts = thesisSetupAlerts(
      thesisWith(
        one({
          left: { source: "price" },
          comparator: "above",
          right: { source: "constant", value: 3_900 },
        }),
        {
          after: {
            condition: one({
              left: { source: "metric", metric: "funding_rate_8h" },
              comparator: "below",
              right: { source: "constant", value: 0 },
            }),
            withinBars: 12,
          },
        },
      ),
    );
    expect(alerts.conditions, "the expressible leg is still armed").toHaveLength(1);
    expect(alerts.inexpressible).toHaveLength(1);
    expect(alerts.inexpressible[0]).toContain("ordering");
    expect(alerts.inexpressible[0]).toContain("no memory of what happened before it");
  });
});

describe("the sentence the user reads", () => {
  const twoLegs: ThesisCondition = {
    match: "all",
    predicates: [
      {
        left: { source: "price" },
        comparator: "above",
        right: { source: "constant", value: 3_900 },
      },
      {
        left: { source: "metric", metric: "funding_rate_8h" },
        comparator: "below",
        right: { source: "constant", value: 0 },
      },
    ],
  };

  it("never lets armed legs read as a fired setup", () => {
    const thesis = thesisWith(twoLegs);
    const line = describeSetupAlerts(thesis, thesisSetupAlerts(thesis));
    expect(line).toContain("2 notify-only legs");
    expect(line, "the leg/setup distinction is the whole risk here").toContain(
      "not the same as the entry firing",
    );
    expect(line).toContain("No order is placed");
  });

  it("says plainly when nothing could be armed", () => {
    const thesis = thesisWith(
      one({
        left: { source: "price" },
        comparator: "crosses_above",
        right: { source: "indicator", indicator: "ema", period: 50 },
      }),
    );
    const line = describeSetupAlerts(thesis, thesisSetupAlerts(thesis));
    expect(line).toContain("Nothing in this entry can be armed");
  });
});
