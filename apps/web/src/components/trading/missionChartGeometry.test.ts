import { EMA_FAST_PERIOD, EMA_SLOW_PERIOD } from "@t3tools/trading-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BAR_MAX_HALF_WIDTH,
  CHART_VIEWBOX_HEIGHT,
  DOMAIN_PADDING_RATIO,
  FUTURE_GUTTER_RATIO,
  GUTTER_LABEL_EDGE_INSET,
  GUTTER_LABEL_MIN_SEPARATION,
  LEFT_AXIS_LANE_WIDTH,
  LEFT_AXIS_LABEL_CHAR_WIDTH,
  LEFT_AXIS_LABEL_MIN_WIDTH_PX,
  LEFT_AXIS_MERGE_DISTANCE_RATIO,
  MIN_CANDLE_DOMAIN_SHARE,
  MAX_DRAWN_CONDITIONS,
  MAX_DRAWN_PAST_MARKERS,
  MIN_CANDLES_FOR_SVG,
  MIN_EVENT_BAND_WIDTH,
  MIN_VISIBLE_BARS,
  PLOT_WIDTH,
  RESEARCH_LABEL_ROW_STEP,
  RESEARCH_MARKER_NOTE,
  computeChartGeometry,
  clusterConditions,
  dedupeConditions,
  deriveEntryFillAtMillis,
  deriveProgressToTarget,
  deriveTargetPrice,
  findLevelAtPrice,
  formatGridPrice,
  formatUtcInstant,
  gridPriceDecimals,
  gridTickTarget,
  isHttpSourceUrl,
  leftAxisLabelWidth,
  layoutGutterLabels,
  layoutLeftAxisLabels,
  medianBarInterval,
  researchMarkerAriaLabel,
  selectVisibleCandles,
  type ChartResearchMarkerInput,
  type ChartStudyOverlayInput,
  type LeftAxisLabelEntry,
} from "./missionChartGeometry";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Five candles spaced 60s apart, closes walking 100→104. */
function fiveWalkingCandles(): ReadonlyArray<{
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}> {
  const base = 1_700_000_000_000;
  return [0, 1, 2, 3, 4].map((i) => ({
    openTime: base + i * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
  }));
}

describe("computeChartGeometry — minimum candle count", () => {
  it("returns null for zero candles", () => {
    expect(
      computeChartGeometry({
        candles: [],
        entryPrice: null,
        stopPrice: null,
        targetPrice: null,
        liquidationPrice: null,
        entryTime: null,
        markPrice: null,
      }),
    ).toBeNull();
  });

  it("returns null for a single candle", () => {
    expect(
      computeChartGeometry({
        candles: [{ openTime: 1, open: 100, high: 101, low: 99, close: 100 }],
        entryPrice: null,
        stopPrice: null,
        targetPrice: null,
        liquidationPrice: null,
        entryTime: null,
        markPrice: null,
      }),
    ).toBeNull();
  });

  it(`returns geometry for ${MIN_CANDLES_FOR_SVG} candles (the threshold)`, () => {
    const geometry = computeChartGeometry({
      candles: [
        { openTime: 1, open: 100, high: 101, low: 99, close: 100 },
        { openTime: 2, open: 100, high: 102, low: 99, close: 101 },
      ],
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    });
    expect(geometry).not.toBeNull();
  });
});

describe("computeChartGeometry — y-domain", () => {
  it("derives the raw domain from candle highs/lows ∪ levels", () => {
    // highs reach 105 (last candle high = 104, but entry 105 widens it); lows
    // bottom at 95 via the stop. rawMin/rawMax are padded 8% after.
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: 102,
      stopPrice: 95,
      targetPrice: 108,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    // raw span is [95, 108] = 13. pad = 13 * 0.08 = 1.04.
    const rawMin = 95;
    const rawMax = 108;
    const pad = (rawMax - rawMin) * DOMAIN_PADDING_RATIO;
    expect(geometry.domainMin).toBeCloseTo(rawMin - pad, 6);
    expect(geometry.domainMax).toBeCloseTo(rawMax + pad, 6);
  });

  it("pads the domain by exactly 8% of the raw span on each side", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    // candles alone: lows min = 99, highs max = 105. span = 6, pad = 0.48.
    const rawMin = 99;
    const rawMax = 105;
    const span = rawMax - rawMin;
    const pad = span * DOMAIN_PADDING_RATIO;
    expect(geometry.domainMin).toBeCloseTo(rawMin - pad, 6);
    expect(geometry.domainMax).toBeCloseTo(rawMax + pad, 6);
    expect(geometry.domainMin).toBeLessThan(rawMin);
    expect(geometry.domainMax).toBeGreaterThan(rawMax);
  });

  it("invents a small span when the domain is zero-height (no NaN/Infinity)", () => {
    const flatCandles = [0, 1, 2].map((i) => ({
      openTime: i,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
    }));
    const geometry = computeChartGeometry({
      candles: flatCandles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(Number.isFinite(geometry.domainMin)).toBe(true);
    expect(Number.isFinite(geometry.domainMax)).toBe(true);
    expect(geometry.domainMax).toBeGreaterThan(geometry.domainMin);
    // yForPrice must be finite for the price itself.
    expect(Number.isFinite(geometry.yForPrice(100))).toBe(true);
  });
});

describe("computeChartGeometry — pre/post split", () => {
  it("splits the line around entryTime, sharing the boundary point", () => {
    const candles = fiveWalkingCandles();
    // entryTime between candle index 1 (openTime = base + 60_000) and index 2
    // (openTime = base + 120_000): candles 0,1 are pre; 2,3,4 are post. Candle
    // 2 is duplicated into the pre segment so the two-tone line joins up
    // instead of breaking a bar wide at the entry.
    const splitAt = candles[1]!.openTime + 30_000;
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: splitAt,
      markPrice: null,
    })!;

    expect(geometry.preEntryPoints).toHaveLength(3);
    expect(geometry.postEntryPoints).toHaveLength(3);
    expect(geometry.preEntryPoints[2]).toEqual(geometry.postEntryPoints[0]);
  });

  it("puts every point in postEntryPoints when entryTime is null", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.preEntryPoints).toHaveLength(0);
    expect(geometry.postEntryPoints).toHaveLength(5);
  });

  it("puts every point in postEntryPoints when entryTime is before the first candle", () => {
    const candles = fiveWalkingCandles();
    const beforeFirst = candles[0]!.openTime - 1_000;
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: beforeFirst,
      markPrice: null,
    })!;

    expect(geometry.preEntryPoints).toHaveLength(0);
    expect(geometry.postEntryPoints).toHaveLength(5);
  });

  it("puts every point in preEntryPoints when entryTime is after the last candle", () => {
    const candles = fiveWalkingCandles();
    const afterLast = candles[candles.length - 1]!.openTime + 1_000;
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: afterLast,
      markPrice: null,
    })!;

    expect(geometry.preEntryPoints).toHaveLength(5);
    expect(geometry.postEntryPoints).toHaveLength(0);
  });
});

describe("computeChartGeometry — liquidation handling", () => {
  it("excludes a far-away liquidation from the domain and from levels", () => {
    // Without liquidation, the domain is ~[99, 105] padded. A liquidation at
    // 5x the range (e.g. 600) must NOT widen the domain, and must NOT appear in
    // the levels array (out of frame).
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: 600,
      entryTime: null,
      markPrice: null,
    })!;

    // Domain stays bounded by the candle range — liquidation did not push it out.
    expect(geometry.domainMax).toBeLessThan(200);
    expect(geometry.levels.find((level) => level.kind === "liquidation")).toBeUndefined();
  });

  it("includes an in-frame liquidation in levels with inFrame true", () => {
    // A liquidation that falls INSIDE the padded range is drawn.
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: 100,
      entryTime: null,
      markPrice: null,
    })!;

    const liquidation = geometry.levels.find((level) => level.kind === "liquidation");
    expect(liquidation).toBeDefined();
    expect(liquidation?.inFrame).toBe(true);
  });

  it("always includes entry/stop/target levels (they are in-frame by construction)", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: 102,
      stopPrice: 98,
      targetPrice: 106,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    const kinds = geometry.levels.map((level) => level.kind).sort();
    expect(kinds).toEqual(["entry", "stop", "target"]);
    for (const level of geometry.levels) {
      expect(level.inFrame).toBe(true);
    }
  });

  it("skips null entry/stop/target levels entirely", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.levels).toHaveLength(0);
  });
});

describe("computeChartGeometry — mark point", () => {
  it("pins the mark at x = PLOT_WIDTH with y mapped from markPrice", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 100,
    })!;

    expect(geometry.markPoint).not.toBeNull();
    expect(geometry.markPoint?.x).toBe(PLOT_WIDTH);
    expect(geometry.markPoint?.y).toBeCloseTo(geometry.yForPrice(100), 6);
  });

  it("returns null markPoint when markPrice is null", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.markPoint).toBeNull();
  });
});

describe("computeChartGeometry — axis mappings", () => {
  it("maps timeStart → the lane's far edge and timeEnd → x=PLOT_WIDTH", () => {
    const candles = fiveWalkingCandles();
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.plotLeft).toBe(LEFT_AXIS_LANE_WIDTH);
    expect(geometry.xForTime(geometry.timeStart)).toBeCloseTo(LEFT_AXIS_LANE_WIDTH, 6);
    expect(geometry.xForTime(geometry.timeEnd)).toBeCloseTo(PLOT_WIDTH, 6);
  });

  it("inverts yForPrice: a higher price yields a smaller y", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    const low = geometry.yForPrice(99);
    const high = geometry.yForPrice(105);
    expect(high).toBeLessThan(low);
  });

  it("maps domainMin → bottom of viewBox and domainMax → top", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.yForPrice(geometry.domainMin)).toBeCloseTo(CHART_VIEWBOX_HEIGHT, 6);
    expect(geometry.yForPrice(geometry.domainMax)).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// deriveTargetPrice
// ---------------------------------------------------------------------------

describe("deriveTargetPrice", () => {
  it("places a long target above the entry (size > 0)", () => {
    // entry 100, profit 50, size 1 → 100 + 50 = 150.
    expect(deriveTargetPrice(100, 50, 1)).toBeCloseTo(150, 6);
  });

  it("places a short target below the entry (size < 0)", () => {
    // entry 100, profit 50, size -1 → 100 - 50 = 50.
    expect(deriveTargetPrice(100, 50, -1)).toBeCloseTo(50, 6);
  });

  it("scales the offset by the size magnitude, not the raw size", () => {
    // entry 100, profit 100, size 2 → 100 + 50 = 150 (offset = 100/|2|).
    expect(deriveTargetPrice(100, 100, 2)).toBeCloseTo(150, 6);
    // short: size -4, profit 200 → offset 50, target 50.
    expect(deriveTargetPrice(100, 200, -4)).toBeCloseTo(50, 6);
  });

  it("names no target for a zero size (no division by zero)", () => {
    expect(deriveTargetPrice(100, 50, 0)).toBeNull();
  });

  it("names no target when the size is too small to reach the planned profit", () => {
    // A short scaled down to dust: 8 / 0.0001 is an 80,000 offset, which puts
    // the "target" at -77,661.33. A price below zero is not a price, and the
    // panel offered to bank the trade there.
    expect(deriveTargetPrice(2338.67, 8, -0.0001)).toBeNull();
  });

  it("still names a target for a small but workable size", () => {
    expect(deriveTargetPrice(2338.67, 8, -1)).toBeCloseTo(2330.67, 6);
  });
});

// ---------------------------------------------------------------------------
// deriveProgressToTarget
// ---------------------------------------------------------------------------

describe("deriveProgressToTarget", () => {
  it("reports 0 at entry and 100 at target (long)", () => {
    expect(deriveProgressToTarget(100, 100, 150)).toBe(0);
    expect(deriveProgressToTarget(150, 100, 150)).toBe(100);
  });

  it("reports the ratio between entry and target", () => {
    // halfway: (125 - 100) / (150 - 100) = 0.5 → 50.
    expect(deriveProgressToTarget(125, 100, 150)).toBeCloseTo(50, 6);
  });

  it("clamps to 100 when the mark blows past the target", () => {
    expect(deriveProgressToTarget(200, 100, 150)).toBe(100);
  });

  it("clamps to 0 when the mark retraces below entry", () => {
    expect(deriveProgressToTarget(80, 100, 150)).toBe(0);
  });

  it("works for a short: target below entry, profit is mark < entry", () => {
    // short: entry 100, target 50, mark 75 → halfway.
    expect(deriveProgressToTarget(75, 100, 50)).toBeCloseTo(50, 6);
    expect(deriveProgressToTarget(50, 100, 50)).toBe(100);
    // blown past target (mark 25, even lower) → clamped 100.
    expect(deriveProgressToTarget(25, 100, 50)).toBe(100);
    // retraced above entry → clamped 0.
    expect(deriveProgressToTarget(120, 100, 50)).toBe(0);
  });

  it("returns 0 when target === entry (no crash)", () => {
    expect(deriveProgressToTarget(100, 100, 100)).toBe(0);
    expect(deriveProgressToTarget(150, 100, 100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveEntryFillAtMillis
// ---------------------------------------------------------------------------

describe("deriveEntryFillAtMillis", () => {
  it("finds the newest 'open' fill", () => {
    const fills = [
      { direction: "Open Long", tradedAt: "2026-08-02T10:00:00.000Z" },
      { direction: "Open Long", tradedAt: "2026-08-02T11:00:00.000Z" }, // newest open
      { direction: "Close Long", tradedAt: "2026-08-02T12:00:00.000Z" }, // later, but close
    ];
    // The newest OPEN — not the newest fill overall.
    expect(deriveEntryFillAtMillis(fills)).toBe(Date.parse("2026-08-02T11:00:00.000Z"));
  });

  it("ignores close and reverse fills", () => {
    const fills = [
      { direction: "Close Long", tradedAt: "2026-08-02T10:00:00.000Z" },
      { direction: "Long > Short", tradedAt: "2026-08-02T11:00:00.000Z" }, // reverse
      { direction: "Close Short", tradedAt: "2026-08-02T12:00:00.000Z" },
    ];
    expect(deriveEntryFillAtMillis(fills)).toBeNull();
  });

  it("returns null when there is no open fill", () => {
    expect(deriveEntryFillAtMillis([])).toBeNull();
    expect(
      deriveEntryFillAtMillis([{ direction: "Close Long", tradedAt: "2026-08-02T10:00:00.000Z" }]),
    ).toBeNull();
  });

  it("returns null when fills have no readable direction", () => {
    const fills = [
      { direction: undefined, tradedAt: "2026-08-02T10:00:00.000Z" },
      { direction: "Buy", tradedAt: "2026-08-02T11:00:00.000Z" }, // spot, not an open
    ];
    expect(deriveEntryFillAtMillis(fills)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// layoutGutterLabels
// ---------------------------------------------------------------------------

describe("layoutGutterLabels", () => {
  // The reported failure: entry 1,859.43, mark 1,869.25 and a close stop all
  // landed within a few viewBox units and rendered on top of each other.
  it("separates labels that would overlap", () => {
    const laid = layoutGutterLabels([
      { y: 80, priority: 0 },
      { y: 82, priority: 2 },
      { y: 84, priority: 3 },
    ]);

    for (let i = 1; i < laid.length; i += 1) {
      expect(laid[i]!.labelY - laid[i - 1]!.labelY).toBeGreaterThanOrEqual(
        GUTTER_LABEL_MIN_SEPARATION - 1e-9,
      );
    }
  });

  // The tag the operator is reading right now must not be the one that moves.
  it("keeps the highest-priority label on its own level", () => {
    const laid = layoutGutterLabels([
      { y: 80, priority: 0 },
      { y: 82, priority: 5 },
    ]);
    const mark = laid.find((tag) => tag.priority === 0);
    expect(mark?.labelY).toBe(80);
  });

  it("preserves top-to-bottom order", () => {
    const laid = layoutGutterLabels([
      { y: 20, priority: 3 },
      { y: 21, priority: 1 },
      { y: 22, priority: 2 },
      { y: 23, priority: 5 },
    ]);
    const ys = laid.map((tag) => tag.labelY);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it("keeps labels inside the frame", () => {
    const laid = layoutGutterLabels([
      { y: 0, priority: 1 },
      { y: 1, priority: 2 },
      { y: CHART_VIEWBOX_HEIGHT, priority: 3 },
      { y: CHART_VIEWBOX_HEIGHT - 1, priority: 4 },
    ]);
    for (const tag of laid) {
      expect(tag.labelY).toBeGreaterThanOrEqual(0);
      expect(tag.labelY).toBeLessThanOrEqual(CHART_VIEWBOX_HEIGHT);
    }
  });

  it("has nothing to lay out for an empty set", () => {
    expect(layoutGutterLabels([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// domain clamping and condition levels
// ---------------------------------------------------------------------------

describe("computeChartGeometry domain sanity", () => {
  const base = 1_700_000_000_000;
  /** Ten candles inside a 2-unit band: the price action a far target used to flatten. */
  const tightCandles = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
    openTime: base + i * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: i % 2 === 0 ? 100.5 : 99.5,
  }));

  const geometryWith = (overrides: {
    readonly targetPrice?: number | null;
    readonly conditions?: ReadonlyArray<{
      readonly price: number;
      readonly direction: "above" | "below";
      readonly met: boolean;
    }>;
  }) =>
    computeChartGeometry({
      candles: tightCandles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: overrides.targetPrice ?? null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 100,
      ...(overrides.conditions === undefined ? {} : { conditions: overrides.conditions }),
    });

  it("does not let a far target flatten the candle series", () => {
    const near = geometryWith({})!;
    const far = geometryWith({ targetPrice: 140 })!;

    // The domain is unchanged: the target is out of reach, so it is not an
    // anchor and the price action keeps its resolution.
    expect(far.domainMin).toBeCloseTo(near.domainMin, 9);
    expect(far.domainMax).toBeCloseTo(near.domainMax, 9);

    const target = far.levels.find((level) => level.kind === "target");
    expect(target?.offScale).toBe("above");
    // Pinned at the top edge, with the true price still on the tag.
    expect(target?.y).toBe(0);
    expect(target?.price).toBe(140);
  });

  it("still anchors a target that is within reach of the candles", () => {
    const geometry = geometryWith({ targetPrice: 102 })!;
    const target = geometry.levels.find((level) => level.kind === "target");
    expect(target?.offScale).toBeNull();
    expect(geometry.domainMax).toBeGreaterThan(102);
  });

  it("draws armed conditions as their own levels, with met state", () => {
    const geometry = geometryWith({
      conditions: [
        { price: 100.8, direction: "above", met: false },
        { price: 99.2, direction: "below", met: true },
      ],
    })!;

    const kinds = geometry.levels.map((level) => level.kind);
    expect(kinds).toContain("condition_above");
    expect(kinds).toContain("condition_below");
    expect(geometry.levels.find((level) => level.kind === "condition_below")?.met).toBe(true);
    expect(geometry.droppedConditions).toBe(0);
  });

  it("draws only the conditions nearest the mark and counts the rest", () => {
    const geometry = geometryWith({
      conditions: [
        { price: 100.1, direction: "above", met: false },
        { price: 100.2, direction: "above", met: false },
        { price: 99.9, direction: "below", met: false },
        { price: 99.8, direction: "below", met: false },
        { price: 130, direction: "above", met: false },
        { price: 70, direction: "below", met: false },
      ],
    })!;

    const drawn = geometry.levels.filter((level) => level.kind.startsWith("condition_"));
    expect(drawn).toHaveLength(MAX_DRAWN_CONDITIONS);
    expect(geometry.droppedConditions).toBe(6 - MAX_DRAWN_CONDITIONS);
    // Whichever survive, they are the near ones: the two far conditions
    // are the first to go, and none of the four near ones is clustered away —
    // 0.1 apart on a 2-unit band is a tenth of the frame, not a coincidence.
    const prices = drawn.map((level) => level.price);
    expect(prices).not.toContain(130);
    expect(prices).not.toContain(70);
    expect(drawn.every((level) => level.count === undefined)).toBe(true);
  });

  it("folds conditions a fraction of the window apart into one level", () => {
    // The stop raised twice: three watches inside a tenth of a unit, on a band
    // two units tall. Three rules there are one line's worth of pixels.
    const geometry = geometryWith({
      conditions: [
        { price: 99.5, direction: "below", met: false },
        { price: 99.47, direction: "below", met: false },
        { price: 99.45, direction: "below", met: true },
      ],
    })!;

    const drawn = geometry.levels.filter((level) => level.kind.startsWith("condition_"));
    expect(drawn).toHaveLength(1);
    expect(geometry.droppedConditions).toBe(0);
    // The nearest the mark — the one the market reaches first — with the count
    // of what it stands for, and `met` as the OR across the cluster.
    expect(drawn[0]?.price).toBe(99.5);
    expect(drawn[0]?.count).toBe(3);
    expect(drawn[0]?.met).toBe(true);
  });

  it("never folds an above and a below condition into one level", () => {
    const geometry = geometryWith({
      conditions: [
        { price: 100, direction: "above", met: false },
        { price: 100, direction: "below", met: false },
      ],
    })!;

    // One price, two opposite statements about it: merging them would lose the
    // only thing either level says.
    const kinds = geometry.levels.map((level) => level.kind);
    expect(kinds).toContain("condition_above");
    expect(kinds).toContain("condition_below");
  });
});

// ---------------------------------------------------------------------------
// gutter tags
// ---------------------------------------------------------------------------

describe("computeChartGeometry gutter tags", () => {
  const base = 1_700_000_000_000;
  const candles = [0, 1, 2, 3].map((i) => ({
    openTime: base + i * 60_000,
    open: 1_860,
    high: 1_872,
    low: 1_856,
    close: 1_865,
  }));

  it("folds a near-identical entry into the mark tag rather than nudging it", () => {
    const geometry = computeChartGeometry({
      candles,
      entryPrice: 1_869.2,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 1_869.25,
    })!;

    const tags = geometry.gutterTags;
    expect(tags.some((tag) => tag.kind === "entry")).toBe(false);
    const mark = tags.find((tag) => tag.kind === "mark");
    expect(mark?.mergedPrice).toBe(1_869.2);
  });

  it("keeps a distinct entry as its own tag", () => {
    const geometry = computeChartGeometry({
      candles,
      entryPrice: 1_857,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 1_871,
    })!;

    expect(geometry.gutterTags.some((tag) => tag.kind === "entry")).toBe(true);
    expect(geometry.gutterTags.find((tag) => tag.kind === "mark")?.mergedPrice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// wall-clock axis
// ---------------------------------------------------------------------------
//
// Without `nowMillis` the axis ends at the last candle, which means the chart
// only moves when a bar closes — on a 1m series, once every sixty seconds, and
// frozen in between. It also puts the mark dot exactly on the final candle at
// the frame's right edge, where a series sliding leftward has nothing to slide
// away from. Both are corrected by passing a clock, and NEITHER may change for
// a caller that does not pass one: the review chart draws a closed window where
// a wall-clock axis would be actively wrong.

describe("computeChartGeometry — wall-clock axis", () => {
  const candles = fiveWalkingCandles();
  const lastOpenTime = candles[candles.length - 1]!.openTime;

  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
  } as const;

  it("leaves the axis on the last candle without a clock", () => {
    const geometry = computeChartGeometry(base);
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.nowX).toBe(PLOT_WIDTH);
    expect(geometry.timeEnd).toBe(lastOpenTime);
    expect(geometry.xForTime(lastOpenTime)).toBeCloseTo(PLOT_WIDTH, 6);
    expect(geometry.markPoint?.x).toBe(PLOT_WIDTH);
    // No clock, no forming bar: the mark sits on the last candle, so the
    // segment between them would have zero length.
    expect(geometry.livePoints).toEqual([]);
  });

  it("ends the axis at the forming bar's close and reserves the future gutter", () => {
    const now = lastOpenTime + 30_000;
    const geometry = computeChartGeometry({ ...base, nowMillis: now });
    if (geometry === null) throw new Error("expected geometry");

    // The ruler ends where the bar being drawn will close, so it holds still
    // while that bar forms.
    expect(geometry.timeEnd).toBe(lastOpenTime + 60_000);
    const axisEndX =
      geometry.plotLeft + (PLOT_WIDTH - geometry.plotLeft) * (1 - FUTURE_GUTTER_RATIO);
    expect(geometry.xForTime(geometry.timeEnd)).toBeCloseTo(axisEndX, 6);
    // `now` is inside the frame, short of that end by the rest of the bar.
    expect(geometry.nowX).toBeLessThan(axisEndX);
    expect(geometry.xForTime(now)).toBeCloseTo(geometry.nowX, 6);
    expect(geometry.markPoint?.x).toBeCloseTo(geometry.nowX, 6);
    // The last candle is behind the mark rather than under it.
    expect(geometry.xForTime(lastOpenTime)).toBeLessThan(geometry.nowX);
  });

  it("holds the series still inside a bar and advances the mark rightward", () => {
    const early = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 10_000 });
    const later = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 40_000 });
    if (early === null || later === null) throw new Error("expected geometry");

    // Same forming bar: the ruler has not moved, so no bar has shifted...
    expect(later.xForTime(lastOpenTime)).toBeCloseTo(early.xForTime(lastOpenTime), 10);
    // ...and the only thing that travelled is the live edge, to the right.
    expect(later.nowX).toBeGreaterThan(early.nowX);
  });

  it("steps the window left by one bar when the forming bar closes", () => {
    const inBar = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 40_000 })!;
    const nextBar = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 70_000 })!;

    const pitch = inBar.xForTime(lastOpenTime) - inBar.xForTime(lastOpenTime - 60_000);
    expect(inBar.xForTime(lastOpenTime) - nextBar.xForTime(lastOpenTime)).toBeCloseTo(pitch, 6);
  });

  it("draws the forming bar from the last close to the mark", () => {
    const now = lastOpenTime + 30_000;
    const geometry = computeChartGeometry({ ...base, nowMillis: now });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.livePoints).toHaveLength(2);
    const [from, to] = geometry.livePoints;
    expect(from!.x).toBeCloseTo(geometry.xForTime(lastOpenTime), 6);
    expect(to!.x).toBeCloseTo(geometry.nowX, 6);
    expect(to!.y).toBeCloseTo(geometry.markPoint!.y, 6);
  });

  // A browser clock behind the server's candle stamps would otherwise run the
  // axis backwards and put the last bar past the right edge.
  it("trusts the candles over a clock that lags them", () => {
    const geometry = computeChartGeometry({ ...base, nowMillis: lastOpenTime - 60_000 });
    if (geometry === null) throw new Error("expected geometry");

    // The clock is thrown away and the last bar becomes "now", so the live
    // edge sits on it rather than a minute to its left.
    expect(geometry.timeEnd).toBe(lastOpenTime + 60_000);
    expect(geometry.xForTime(lastOpenTime)).toBeCloseTo(geometry.nowX, 6);
  });
});

describe("computeChartGeometry — time markers", () => {
  const candles = fiveWalkingCandles();
  const firstOpenTime = candles[0]!.openTime;
  const lastOpenTime = candles[candles.length - 1]!.openTime;
  const now = lastOpenTime + 30_000;

  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
    nowMillis: now,
  } as const;

  it("places a future marker in the gutter, right of now", () => {
    const geometry = computeChartGeometry({
      ...base,
      timeMarkers: [{ key: "reassess", label: "reassess", at: now + 60_000 }],
    });
    if (geometry === null) throw new Error("expected geometry");

    const marker = geometry.timeMarkers[0]!;
    expect(marker.x).toBeGreaterThan(geometry.nowX);
    expect(marker.x).toBeLessThanOrEqual(PLOT_WIDTH);
    expect(marker.overdue).toBe(false);
  });

  // A reassessment further out than the gutter reaches still belongs on screen:
  // pinned at the far edge says "beyond this frame", drawing it off-canvas says
  // nothing at all.
  it("pins a distant marker at the plot edge rather than dropping it", () => {
    const geometry = computeChartGeometry({
      ...base,
      timeMarkers: [{ key: "reassess", label: "reassess", at: now + 86_400_000 }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeMarkers[0]!.x).toBe(PLOT_WIDTH);
  });

  it("marks a passed reassessment as overdue", () => {
    const geometry = computeChartGeometry({
      ...base,
      timeMarkers: [{ key: "reassess", label: "reassess", at: now - 10_000 }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeMarkers[0]!.overdue).toBe(true);
    // Clamped forward to now: an overdue event is not in the past of the axis,
    // it is the next thing that should happen.
    expect(geometry.timeMarkers[0]!.x).toBeCloseTo(geometry.nowX, 6);
  });

  // The rug of past events. An event before the window's first candle has no
  // honest x — the same rule the fill markers already follow.
  it("places past events inside the drawn window and drops the ones before it", () => {
    const geometry = computeChartGeometry({
      ...base,
      pastMarkers: [
        { key: "recent", kind: "wake", at: now - 30_000, cause: "scheduled_reassessment" },
        { key: "ancient", kind: "wake", at: firstOpenTime - 60_000 },
      ],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.pastMarkers.map((marker) => marker.key)).toEqual(["recent"]);
    expect(geometry.pastMarkers[0]!.x).toBeGreaterThan(0);
    expect(geometry.pastMarkers[0]!.x).toBeLessThanOrEqual(geometry.nowX);
    expect(geometry.pastMarkers[0]!.cause).toBe("scheduled_reassessment");
  });

  // Newest-first in, so the cap has to drop the OLDEST — a rug trimmed from the
  // front would stop before the events that just happened.
  it("caps the rug at the newest events", () => {
    const geometry = computeChartGeometry({
      ...base,
      pastMarkers: Array.from({ length: MAX_DRAWN_PAST_MARKERS + 5 }, (_unused, index) => ({
        key: `w${index}`,
        kind: "wake",
        at: now - index * 1_000,
      })),
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.pastMarkers).toHaveLength(MAX_DRAWN_PAST_MARKERS);
    expect(geometry.pastMarkers[0]!.key).toBe("w0");
  });

  it("carries the marker's tone through, defaulting to planned", () => {
    const geometry = computeChartGeometry({
      ...base,
      timeMarkers: [
        { key: "floor", label: "", at: now + 60_000, tone: "auto" as const },
        { key: "reassess", label: "reassess", at: now + 120_000 },
      ],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeMarkers.map((marker) => marker.tone)).toEqual(["auto", "planned"]);
  });

  it("ignores markers without a clock to place them against", () => {
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 104,
      timeMarkers: [{ key: "reassess", label: "reassess", at: lastOpenTime + 60_000 }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.timeMarkers).toEqual([]);
  });
});

describe("computeChartGeometry — fill markers", () => {
  const candles = fiveWalkingCandles();
  const timeStart = candles[0]!.openTime;
  const lastOpenTime = candles[candles.length - 1]!.openTime;

  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
  } as const;

  it("places a fill at its own time and price", () => {
    const at = timeStart + 120_000;
    const geometry = computeChartGeometry({
      ...base,
      fills: [{ key: "a", at, price: 102, kind: "open" }],
    });
    if (geometry === null) throw new Error("expected geometry");

    const point = geometry.fillPoints[0]!;
    expect(point.key).toBe("a");
    expect(point.x).toBeCloseTo(geometry.xForTime(at), 6);
    expect(point.y).toBeCloseTo(geometry.yForPrice(102), 6);
    expect(point.kind).toBe("open");
  });

  // A closed position's two fills outlive the position row itself, which is the
  // whole reason they are drawn: the chart is the session's record.
  it("keeps both ends of a position that has already closed", () => {
    const geometry = computeChartGeometry({
      ...base,
      fills: [
        { key: "in", at: timeStart + 60_000, price: 101, kind: "open" },
        { key: "out", at: timeStart + 180_000, price: 103, kind: "close_profit" },
      ],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.fillPoints.map((p) => p.key)).toEqual(["in", "out"]);
    expect(geometry.fillPoints[0]!.x).toBeLessThan(geometry.fillPoints[1]!.x);
  });

  // Placing it at x=0 would claim it happened at the window's first candle.
  it("drops a fill older than the window rather than pinning it left", () => {
    const geometry = computeChartGeometry({
      ...base,
      fills: [{ key: "ancient", at: timeStart - 600_000, price: 101, kind: "open" }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.fillPoints).toEqual([]);
  });

  it("clamps a fill price outside the domain into the frame", () => {
    const geometry = computeChartGeometry({
      ...base,
      fills: [{ key: "spike", at: lastOpenTime, price: 10_000, kind: "close_loss" }],
    });
    if (geometry === null) throw new Error("expected geometry");

    const point = geometry.fillPoints[0]!;
    expect(point.y).toBe(0);
    expect(point.price).toBe(10_000);
  });

  it("pins a fill newer than the axis at now", () => {
    const geometry = computeChartGeometry({
      ...base,
      nowMillis: lastOpenTime + 30_000,
      fills: [{ key: "just-now", at: lastOpenTime + 120_000, price: 104, kind: "open" }],
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.fillPoints[0]!.x).toBeCloseTo(geometry.nowX, 6);
  });

  it("draws no markers when none are passed", () => {
    const geometry = computeChartGeometry(base);
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.fillPoints).toEqual([]);
  });
});

describe("computeChartGeometry — pending order", () => {
  const candles = fiveWalkingCandles();

  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
  } as const;

  it("draws a resting buy as its own level kind", () => {
    const geometry = computeChartGeometry({
      ...base,
      pendingOrder: { price: 101.5, side: "buy" },
    });
    if (geometry === null) throw new Error("expected geometry");

    const level = geometry.levels.find((l) => l.kind === "pending_buy");
    expect(level?.price).toBe(101.5);
    expect(level?.inFrame).toBe(true);
  });

  it("draws a resting sell as its own level kind", () => {
    const geometry = computeChartGeometry({
      ...base,
      pendingOrder: { price: 103.5, side: "sell" },
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.levels.some((l) => l.kind === "pending_sell")).toBe(true);
  });

  it("gives the resting order a gutter tag", () => {
    const geometry = computeChartGeometry({
      ...base,
      pendingOrder: { price: 101.5, side: "buy" },
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.gutterTags.some((tag) => tag.kind === "pending_buy")).toBe(true);
  });

  // The order is a price the market is expected to reach, so a window that
  // excluded it would hide the very thing about to happen.
  it("anchors the y-domain on the resting order's price", () => {
    const geometry = computeChartGeometry({
      ...base,
      pendingOrder: { price: 97, side: "buy" },
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.domainMin).toBeLessThan(97);
  });

  it("draws no pending level when there is no resting order", () => {
    const geometry = computeChartGeometry({ ...base, pendingOrder: null });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.levels.some((l) => l.kind.startsWith("pending"))).toBe(false);
  });
});

describe("selectVisibleCandles", () => {
  const series = Array.from({ length: 120 }, (_, i) => ({
    openTime: 1_700_000_000_000 + i * 60_000,
    close: 100 + i,
  }));

  it("draws the plain tail when nothing older has to stay in frame", () => {
    const visible = selectVisibleCandles(series, 60, null);
    expect(visible).toHaveLength(60);
    expect(visible[0]!.openTime).toBe(series[60]!.openTime);
  });

  // The fill markers are the session's record; a window that cropped them would
  // be the same as not drawing them.
  it("widens the window to keep an older fill visible", () => {
    const oldFill = series[10]!.openTime;
    const visible = selectVisibleCandles(series, 60, oldFill);

    expect(visible.length).toBeGreaterThan(60);
    expect(visible[0]!.openTime).toBeLessThanOrEqual(oldFill);
  });

  it("never narrows the window for a recent fill", () => {
    const recent = series[110]!.openTime;
    expect(selectVisibleCandles(series, 60, recent)).toHaveLength(60);
  });

  it("gives back everything it has when the fill predates the series", () => {
    const visible = selectVisibleCandles(series, 60, series[0]!.openTime - 600_000);
    expect(visible).toHaveLength(series.length);
  });

  it("keeps the tail when the fill is newer than every bar", () => {
    const visible = selectVisibleCandles(series, 60, series[119]!.openTime + 600_000);
    expect(visible).toHaveLength(60);
  });

  // Final-form phase 6: the window floor lives with the windowing function, so
  // no caller can narrow the chart below a readable 60-bar window.
  it(`floors a narrower ask at ${MIN_VISIBLE_BARS} bars`, () => {
    expect(selectVisibleCandles(series, 24, null)).toHaveLength(MIN_VISIBLE_BARS);
  });

  it("honours an ask wider than the floor", () => {
    expect(selectVisibleCandles(series, 100, null)).toHaveLength(100);
  });

  it("gives back everything when the series is shorter than the floor", () => {
    expect(selectVisibleCandles(series.slice(0, 30), 24, null)).toHaveLength(30);
  });
});

describe("findLevelAtPrice", () => {
  /** Three drawn levels, of the kinds a mission actually carries at once. */
  const levels = [
    { kind: "entry" as const, price: 1900, y: 80, inFrame: true, offScale: null, futureEndX: 880 },
    { kind: "stop" as const, price: 1908.5, y: 20, inFrame: true, offScale: null, futureEndX: 880 },
    {
      kind: "target" as const,
      price: 1885,
      y: 150,
      inFrame: true,
      offScale: null,
      futureEndX: 880,
    },
  ];

  it("returns the level a pill's price names", () => {
    expect(findLevelAtPrice(levels, 1908.5)?.kind).toBe("stop");
  });

  it("tolerates the float drift of a price derived twice", () => {
    expect(findLevelAtPrice(levels, 1908.5 + 1e-9)?.kind).toBe("stop");
  });

  it("returns null for a price the chart draws no level at", () => {
    expect(findLevelAtPrice(levels, 1899)).toBeNull();
  });

  it("does not snap a near miss to the closest level", () => {
    // A cent away is a different price, and lighting up the stop here would
    // point the operator at a level they did not click.
    expect(findLevelAtPrice(levels, 1908.51)).toBeNull();
  });

  it("returns null when nothing is drawn at all", () => {
    expect(findLevelAtPrice([], 1900)).toBeNull();
  });
});

describe("computeChartGeometry — candles", () => {
  const base = {
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: null,
  };

  it("places every bar's body and wicks, ordered for a rect", () => {
    const geometry = computeChartGeometry({ ...base, candles: fiveWalkingCandles() });

    expect(geometry).not.toBeNull();
    expect(geometry!.bars).toHaveLength(5);
    for (const bar of geometry!.bars) {
      // y is inverted, so the high is the smallest number of the four.
      expect(bar.highY).toBeLessThanOrEqual(bar.bodyTop);
      expect(bar.bodyTop).toBeLessThanOrEqual(bar.bodyBottom);
      expect(bar.bodyBottom).toBeLessThanOrEqual(bar.lowY);
      expect(bar.halfWidth).toBeGreaterThan(0);
      expect(bar.halfWidth).toBeLessThanOrEqual(BAR_MAX_HALF_WIDTH);
    }
  });

  it("calls a bar by where it closed against where it opened", () => {
    const candles = [
      { openTime: 0, open: 100, high: 105, low: 99, close: 104 },
      { openTime: 60_000, open: 104, high: 104, low: 98, close: 99 },
      // A doji: no body at all, and still a bar that happened.
      { openTime: 120_000, open: 99, high: 100, low: 98, close: 99 },
    ];
    const bars = computeChartGeometry({ ...base, candles })!.bars;

    expect(bars.map((bar) => bar.direction)).toEqual(["up", "down", "up"]);
    expect(bars[2]!.bodyTop).toBe(bars[2]!.bodyBottom);
  });

  it("maps each bar's coordinates through the same axes everything else uses", () => {
    // The renderer draws the bars verbatim, so the geometry must place them on
    // the shared xForTime/yForPrice mapping: a bar off its own candle's x, or a
    // body edge off the open/close prices, would sit beside the fills and
    // levels rather than under them. Real bodies, both directions — the shared
    // fixture's opens equal its closes, which would let a swapped open/close
    // mapping pass unnoticed.
    const candles = [
      { openTime: 0, open: 100, high: 106, low: 99, close: 105 },
      { openTime: 60_000, open: 105, high: 107, low: 101, close: 102 },
      { openTime: 120_000, open: 102, high: 104, low: 100, close: 103 },
    ];
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    expect(geometry.bars).toHaveLength(candles.length);
    for (const [index, bar] of geometry.bars.entries()) {
      const candle = candles[index]!;
      expect(bar.key).toBe(candle.openTime);
      expect(bar.x).toBeCloseTo(geometry.xForTime(candle.openTime), 10);
      expect(bar.highY).toBeCloseTo(geometry.yForPrice(candle.high), 10);
      expect(bar.lowY).toBeCloseTo(geometry.yForPrice(candle.low), 10);
      // y is inverted, so the HIGHER of open/close is the body's top edge.
      expect(bar.bodyTop).toBeCloseTo(geometry.yForPrice(Math.max(candle.open, candle.close)), 10);
      expect(bar.bodyBottom).toBeCloseTo(
        geometry.yForPrice(Math.min(candle.open, candle.close)),
        10,
      );
    }
  });

  it("draws no bodies for a series that carries only closes", () => {
    // A body drawn from a guessed open is a bar that did not happen; the line
    // still draws, so the chart degrades rather than lying.
    const candles = fiveWalkingCandles().map(({ openTime, high, low, close }) => ({
      openTime,
      high,
      low,
      close,
    }));
    const geometry = computeChartGeometry({ ...base, candles })!;

    expect(geometry.bars).toEqual([]);
    expect(geometry.postEntryPoints).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// A chart that does not move while the price does
// ---------------------------------------------------------------------------
//
// The complaint these cover: the series "jumped" and "distorted" as live
// prices came in. It was the ruler, not the data — fitting `timeStart..now` to
// a fixed plot width made the scale a function of the wall clock.

describe("computeChartGeometry — a stable scale under a live clock", () => {
  const candles = fiveWalkingCandles();
  const lastOpenTime = candles[candles.length - 1]!.openTime;
  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
  } as const;

  it("keeps the bar pitch identical as the clock advances", () => {
    const early = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 5_000 })!;
    const later = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 55_000 })!;

    // Same candles, 50 seconds apart, one forming bar: no bar has changed
    // width and none has moved. The live edge is the only thing that travelled.
    expect(later.bars[0]!.halfWidth).toBeCloseTo(early.bars[0]!.halfWidth, 10);
    expect(later.xForTime(lastOpenTime)).toBeCloseTo(early.xForTime(lastOpenTime), 10);
    expect(later.xForTime(candles[0]!.openTime)).toBeCloseTo(
      early.xForTime(candles[0]!.openTime),
      10,
    );
    expect(later.nowX - early.nowX).toBeGreaterThan(0);
  });

  it("does not change the scale when a new candle closes", () => {
    const before = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 59_000 })!;
    const nextCandle = {
      openTime: lastOpenTime + 60_000,
      open: 104,
      high: 105,
      low: 103,
      close: 104,
    };
    const after = computeChartGeometry({
      ...base,
      candles: [...candles.slice(1), nextCandle],
      nowMillis: lastOpenTime + 61_000,
    })!;

    // The old fit-to-window axis re-scaled here, so the whole series snapped
    // sideways once a minute. Same window length in, same pitch out.
    expect(after.bars[0]!.halfWidth).toBeCloseTo(before.bars[0]!.halfWidth, 10);
    expect(after.xForTime(after.timeEnd) - after.xForTime(after.timeEnd - 60_000)).toBeCloseTo(
      before.xForTime(before.timeEnd) - before.xForTime(before.timeEnd - 60_000),
      10,
    );
  });

  it("reads the bar interval as the median gap, not the mean", () => {
    // One missing bar leaves a double gap; the median ignores it.
    expect(
      medianBarInterval([
        { openTime: 0 },
        { openTime: 60_000 },
        { openTime: 180_000 },
        { openTime: 240_000 },
      ]),
    ).toBe(60_000);
    expect(medianBarInterval([{ openTime: 0 }])).toBe(60_000);
  });
});

describe("computeChartGeometry — the candles keep their share of the frame", () => {
  it("drops a level that would flatten the price action", () => {
    const candles = fiveWalkingCandles();
    // The candle window is 99..105; a target 60 below it would leave the bars
    // a tenth of the domain.
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: 40,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
    })!;

    const candleShare = (105 - 99) / (geometry.domainMax - geometry.domainMin);
    expect(candleShare).toBeGreaterThanOrEqual(MIN_CANDLE_DOMAIN_SHARE);
    // The level is still on the chart — pinned at the edge with a chevron.
    const target = geometry.levels.find((level) => level.kind === "target")!;
    expect(target.offScale).toBe("below");
  });
});

describe("one rule per price", () => {
  it("folds two watches at one level into a single condition", () => {
    const deduped = dedupeConditions([
      { price: 1_876.6, direction: "above", met: false },
      { price: 1_876.6, direction: "above", met: true },
      { price: 1_860, direction: "below", met: false },
    ]);

    expect(deduped).toHaveLength(2);
    // Any watch at the price having fired means the level was reached.
    expect(deduped.find((condition) => condition.price === 1_876.6)?.met).toBe(true);
  });

  it("does not draw a condition on top of a level the chart already names", () => {
    const geometry = computeChartGeometry({
      candles: fiveWalkingCandles(),
      entryPrice: null,
      stopPrice: null,
      targetPrice: 106,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 104,
      conditions: [{ price: 106, direction: "above", met: false }],
    })!;

    expect(geometry.levels.filter((level) => level.price === 106)).toHaveLength(1);
    expect(geometry.levels.find((level) => level.price === 106)?.kind).toBe("target");
  });
});

describe("gutter tags stay inside the chart", () => {
  it("holds every tag an inset clear of both edges", () => {
    // Six levels crowded into the bottom of a shallow domain: the layout has
    // to spread them without letting the last one hang below the frame.
    const placed = layoutGutterLabels(
      [0, 1, 2, 3, 4, 5].map((index) => ({ y: CHART_VIEWBOX_HEIGHT - index, priority: index })),
    );

    for (const tag of placed) {
      expect(tag.labelY).toBeGreaterThanOrEqual(GUTTER_LABEL_EDGE_INSET);
      expect(tag.labelY).toBeLessThanOrEqual(CHART_VIEWBOX_HEIGHT - GUTTER_LABEL_EDGE_INSET);
    }
  });
});

describe("the two moving averages", () => {
  const walk = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const close = 100 + Math.sin(index / 4) * 2;
      return {
        openTime: 1_700_000_000_000 + index * 60_000,
        open: close,
        high: close + 0.5,
        low: close - 0.5,
        close,
      };
    });

  const geometryFor = (count: number) =>
    computeChartGeometry({
      candles: walk(count),
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 100,
    });

  it("draws the fast and slow EMAs at the strategy's own periods", () => {
    const geometry = geometryFor(60)!;

    expect(geometry.emaLines.map((line) => line.period)).toEqual([
      EMA_SLOW_PERIOD,
      EMA_FAST_PERIOD,
    ]);
    // Slow first: it is drawn under the fast one, which is the line that
    // crosses.
    expect(geometry.emaLines[0]?.speed).toBe("slow");

    // Each starts where its seed average completes and runs to the last bar.
    for (const line of geometry.emaLines) {
      expect(line.points).toHaveLength(60 - line.period + 1);
      expect(line.points[line.points.length - 1]?.x).toBeCloseTo(geometry.nowX, 6);
    }
  });

  it("draws neither average when the window is too short for both", () => {
    // Long enough for the fast one alone — which says nothing about a cross,
    // so the pair is suppressed rather than drawn half-complete.
    expect(geometryFor(EMA_SLOW_PERIOD - 1)!.emaLines).toEqual([]);
  });

  it("reports each average's newest value at the price it is drawn at", () => {
    const geometry = geometryFor(60)!;

    for (const line of geometry.emaLines) {
      const last = line.points[line.points.length - 1]!;
      expect(last.y).toBeCloseTo(geometry.yForPrice(line.lastValue), 9);
    }
  });
});

// ---------------------------------------------------------------------------
// bounded trigger projections — plan 29 step 8.1
// ---------------------------------------------------------------------------
//
// Every level's rule used to run the full width of the plot, which after the
// future gutter arrived meant it ran through the gutter too — asserting, in the
// same ink it uses for the record, that the level will still be there. A named
// level will be; an armed entry trigger will not, because the plan that armed
// it goes stale at its own reassessment.

describe("computeChartGeometry — level projections into the future gutter", () => {
  const candles = fiveWalkingCandles();
  const lastOpenTime = candles[candles.length - 1]!.openTime;
  const now = lastOpenTime + 30_000;

  const base = {
    candles,
    entryPrice: null,
    stopPrice: 99,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
    conditions: [{ price: 103, direction: "above" as const, met: false }],
  } as const;

  it("ends every rule at nowX without a clock, as the review chart draws them", () => {
    const geometry = computeChartGeometry(base);
    if (geometry === null) throw new Error("expected geometry");

    for (const level of geometry.levels) {
      expect(level.futureEndX).toBe(geometry.nowX);
      expect(level.futureEndX).toBe(PLOT_WIDTH);
    }
  });

  it("projects named levels to the frame edge with a clock", () => {
    const geometry = computeChartGeometry({ ...base, nowMillis: now });
    if (geometry === null) throw new Error("expected geometry");

    const stop = geometry.levels.find((level) => level.kind === "stop");
    expect(stop?.futureEndX).toBe(PLOT_WIDTH);
  });

  it("stops a trigger's projection at the plan's reassessment", () => {
    // Inside the gutter: the whole future gutter is FUTURE_GUTTER_RATIO of a
    // window five one-minute bars wide, so ~40s of clock fits in it.
    const expiry = now + 20_000;
    const geometry = computeChartGeometry({ ...base, nowMillis: now, triggerExpiryAt: expiry });
    if (geometry === null) throw new Error("expected geometry");

    const trigger = geometry.levels.find((level) => level.kind === "condition_above");
    expect(trigger?.futureEndX).toBeCloseTo(geometry.xForTime(expiry), 6);
    expect(trigger?.futureEndX).toBeGreaterThan(geometry.nowX);
    expect(trigger?.futureEndX).toBeLessThan(PLOT_WIDTH);
    // The named levels are untouched by the trigger's horizon.
    expect(geometry.levels.find((level) => level.kind === "stop")?.futureEndX).toBe(PLOT_WIDTH);
  });

  it("pins a reassessment beyond the gutter at the frame edge", () => {
    const geometry = computeChartGeometry({
      ...base,
      nowMillis: now,
      triggerExpiryAt: now + 90 * 60_000,
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.levels.find((level) => level.kind === "condition_above")?.futureEndX).toBe(
      PLOT_WIDTH,
    );
  });

  it("draws no projection at all once the reassessment has passed", () => {
    // A plan past its own freshness horizon is not a plan the mission is still
    // waiting on, so its trigger says nothing about the future.
    const geometry = computeChartGeometry({
      ...base,
      nowMillis: now,
      triggerExpiryAt: now - 60_000,
    });
    if (geometry === null) throw new Error("expected geometry");

    expect(geometry.levels.find((level) => level.kind === "condition_above")?.futureEndX).toBe(
      geometry.nowX,
    );
  });
});

// ---------------------------------------------------------------------------
// the conveyor's rate — plan 29 step 8.2
// ---------------------------------------------------------------------------
//
// Step 8.2 asks for `nowX` to advance smoothly rather than jumping per
// projection update. It does not jump per projection update at all: `nowX` is a
// constant, the axis is anchored at the wall clock rather than at the newest
// candle, and the scale is held constant at one bar interval per bar. What
// moves is the series, at a fixed rate, driven by the panel's 1Hz ticker.
//
// These pin the two properties that make that motion continuous rather than
// stepped. If either breaks, the chart starts lurching and the conveyor stops
// reading as one.

describe("computeChartGeometry — the series slides at a constant rate", () => {
  const candles = fiveWalkingCandles();
  const lastOpenTime = candles[candles.length - 1]!.openTime;

  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
  } as const;

  /** How far a fixed moment moves between two clocks. */
  function displacement(fromMillis: number, toMillis: number): number {
    const before = computeChartGeometry({ ...base, nowMillis: fromMillis })!;
    const after = computeChartGeometry({ ...base, nowMillis: toMillis })!;
    return before.xForTime(lastOpenTime) - after.xForTime(lastOpenTime);
  }

  it("does not move a drawn bar while a bar is forming, wherever the clock is", () => {
    // The ruler is pinned to the forming bar's close, so a second passing does
    // not move the record — it moves the live edge toward that close. A drawn
    // bar that crept between ticks would be a bar whose x meant "when the
    // browser last rendered" rather than "when it traded".
    expect(displacement(lastOpenTime + 1_000, lastOpenTime + 2_000)).toBeCloseTo(0, 9);
    expect(displacement(lastOpenTime + 58_000, lastOpenTime + 59_000)).toBeCloseTo(0, 9);
  });

  it("steps by exactly one bar pitch across a close, and by nothing inside one", () => {
    const geometry = computeChartGeometry({ ...base, nowMillis: lastOpenTime + 10_000 })!;
    const pitch = geometry.xForTime(lastOpenTime) - geometry.xForTime(lastOpenTime - 60_000);

    expect(displacement(lastOpenTime + 59_500, lastOpenTime + 60_500)).toBeCloseTo(pitch, 9);
    expect(displacement(lastOpenTime + 10_000, lastOpenTime + 11_000)).toBeCloseTo(0, 9);
  });

  it("advances by less than half a viewBox unit per second on a 1m window", () => {
    // Why no animation loop: at 60 one-minute bars the whole window is an hour
    // wide, so one second of the clock moves the live edge `axisEndX / 3600`
    // units — about a fifth of a unit, which at the widths this panel renders
    // at is a fraction of one device pixel. The motion is already below the
    // threshold where a step is distinguishable from a slide, and a
    // requestAnimationFrame loop would spend a frame budget on a quarter pixel.
    const hourWindow = Array.from({ length: 60 }, (_, i) => ({
      openTime: 1_700_000_000_000 + i * 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
    }));
    const now = hourWindow[hourWindow.length - 1]!.openTime + 30_000;
    const before = computeChartGeometry({ ...base, candles: hourWindow, nowMillis: now })!;
    const after = computeChartGeometry({ ...base, candles: hourWindow, nowMillis: now + 1_000 })!;
    // The bars stand still inside a bar; the live edge is what moves.
    expect(after.xForTime(hourWindow[0]!.openTime)).toBeCloseTo(
      before.xForTime(hourWindow[0]!.openTime),
      10,
    );
    const perSecond = after.nowX - before.nowX;

    expect(perSecond).toBeGreaterThan(0);
    expect(perSecond).toBeLessThan(0.5);
  });
});

describe("computeChartGeometry zones", () => {
  // A flat 100-price window, so every price maps to a y that is easy to state.
  const candles = [
    { openTime: 1_000, open: 100, high: 102, low: 98, close: 100 },
    { openTime: 2_000, open: 100, high: 102, low: 98, close: 100 },
    { openTime: 3_000, open: 100, high: 102, low: 98, close: 100 },
  ];
  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: null,
  };

  it("places a band inside the domain between the y of its two prices", () => {
    const geometry = computeChartGeometry({
      ...base,
      zones: [
        {
          key: "z",
          label: "projected",
          priceLow: 99,
          priceHigh: 101,
          tone: "plan",
          register: "hypothetical",
        },
      ],
    });
    expect(geometry).not.toBeNull();
    const zone = geometry!.zones[0]!;
    expect(zone.y).toBeCloseTo(geometry!.yForPrice(101), 6);
    expect(zone.height).toBeCloseTo(geometry!.yForPrice(99) - geometry!.yForPrice(101), 6);
    expect(zone.offScale).toBeNull();
    expect(zone.register).toBe("hypothetical");
  });

  it("orders the band's own endpoints, so a caller cannot invert one", () => {
    const geometry = computeChartGeometry({
      ...base,
      zones: [
        {
          key: "z",
          label: "projected",
          priceLow: 101,
          priceHigh: 99,
          tone: "plan",
          register: "hypothetical",
        },
      ],
    });
    expect(geometry!.zones[0]).toMatchObject({ priceLow: 99, priceHigh: 101 });
    expect(geometry!.zones[0]!.height).toBeGreaterThan(0);
  });

  it("clips a band that runs off the top to the part inside the frame", () => {
    const geometry = computeChartGeometry({
      ...base,
      zones: [
        {
          key: "z",
          label: "projected",
          priceLow: 100,
          priceHigh: 10_000,
          tone: "plan",
          register: "hypothetical",
        },
      ],
    });
    const zone = geometry!.zones[0]!;
    expect(zone.y).toBe(0);
    expect(zone.height).toBeCloseTo(geometry!.yForPrice(100), 6);
    expect(zone.height).toBeLessThanOrEqual(CHART_VIEWBOX_HEIGHT);
  });

  it("draws no rect for a band the domain never reaches, and says which way", () => {
    const geometry = computeChartGeometry({
      ...base,
      zones: [
        {
          key: "high",
          label: "projected",
          priceLow: 5_000,
          priceHigh: 6_000,
          tone: "plan",
          register: "hypothetical",
        },
        {
          key: "low",
          label: "projected",
          priceLow: 1,
          priceHigh: 2,
          tone: "plan",
          register: "hypothetical",
        },
      ],
    });
    const [high, low] = geometry!.zones;
    expect(high).toMatchObject({ offScale: "above", height: 0 });
    expect(low).toMatchObject({ offScale: "below", height: 0 });
    // Off-scale or not, the chip is still docked inside the frame.
    expect(high!.labelY).toBeGreaterThanOrEqual(GUTTER_LABEL_EDGE_INSET);
    expect(low!.labelY).toBeLessThanOrEqual(CHART_VIEWBOX_HEIGHT - GUTTER_LABEL_EDGE_INSET);
  });

  it("holds a zone chip apart from the level chips it crowds", () => {
    // A stop, a target and a band all inside a few units of price of each
    // other: without a shared layout pass the zone chip lands on a level chip.
    const geometry = computeChartGeometry({
      ...base,
      entryPrice: 100,
      stopPrice: 99.5,
      targetPrice: 100.5,
      markPrice: 100.1,
      zones: [
        {
          key: "z",
          label: "projected",
          priceLow: 99.9,
          priceHigh: 100.2,
          tone: "plan",
          register: "hypothetical",
        },
      ],
    });
    const ys = [
      ...geometry!.gutterTags.map((tag) => tag.labelY),
      ...geometry!.zones.map((zone) => zone.labelY),
    ].sort((left, right) => left - right);
    for (let index = 1; index < ys.length; index += 1) {
      expect(ys[index]! - ys[index - 1]!).toBeGreaterThanOrEqual(
        GUTTER_LABEL_MIN_SEPARATION - 1e-6,
      );
    }
  });

  it("leaves the gutter exactly as it was when no zone is passed", () => {
    const withoutZones = computeChartGeometry({ ...base, entryPrice: 100, markPrice: 100.4 });
    const withEmptyZones = computeChartGeometry({
      ...base,
      entryPrice: 100,
      markPrice: 100.4,
      zones: [],
    });
    expect(withEmptyZones!.zones).toEqual([]);
    expect(withEmptyZones!.gutterTags).toEqual(withoutZones!.gutterTags);
  });
});

describe("computeChartGeometry past-marker labels", () => {
  const candles = [
    { openTime: 1_000, open: 100, high: 102, low: 98, close: 100 },
    { openTime: 2_000, open: 100, high: 102, low: 98, close: 100 },
  ];

  it("carries the timeline's own sentence through to the tick", () => {
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
      nowMillis: 2_500,
      pastMarkers: [
        { key: "a", kind: "wake", at: 1_500, label: "A level it was watching was reached" },
        { key: "b", kind: "journal", at: 1_800 },
      ],
    });
    expect(geometry!.pastMarkers[0]!.label).toBe("A level it was watching was reached");
    // Absent rather than empty: a tick with no sentence draws no tooltip.
    expect(geometry!.pastMarkers[1]!.label).toBeUndefined();
  });
});

describe("clusterConditions and the hypothetical register", () => {
  it("carries the representative's caption and register through a cluster", () => {
    const clustered = clusterConditions(
      [
        {
          price: 100,
          direction: "above",
          met: false,
          label: "The 5m fade",
          register: "hypothetical",
        },
        {
          price: 100.5,
          direction: "above",
          met: false,
          label: "The 5m fade",
          register: "hypothetical",
        },
      ],
      2,
      99,
    );
    expect(clustered).toHaveLength(1);
    expect(clustered[0]).toMatchObject({
      label: "The 5m fade",
      register: "hypothetical",
      count: 2,
    });
  });

  it("never merges an armed watch with a claimed level", () => {
    // A few cents apart and the same direction, so only the register keeps
    // them apart. Merged, one chip would state one register about both.
    const clustered = clusterConditions(
      [
        { price: 100, direction: "above", met: false, id: "watch-1" },
        {
          price: 100.2,
          direction: "above",
          met: false,
          label: "The 5m fade",
          register: "hypothetical",
        },
      ],
      2,
      99,
    );
    expect(clustered).toHaveLength(2);
    expect(clustered.map((c) => c.register)).toEqual([undefined, "hypothetical"]);
    expect(clustered[0]!.id).toBe("watch-1");
  });

  it("draws a claimed entry level as a chip that says which thesis it belongs to", () => {
    const geometry = computeChartGeometry({
      candles: [
        { openTime: 1_000, open: 100, high: 102, low: 98, close: 100 },
        { openTime: 2_000, open: 100, high: 102, low: 98, close: 100 },
      ],
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 100,
      conditions: [
        {
          price: 101,
          direction: "above",
          met: false,
          label: "The 5m fade",
          register: "hypothetical",
        },
      ],
    });
    const chip = geometry!.gutterTags.find((tag) => tag.kind === "condition_above");
    expect(chip).toMatchObject({ label: "The 5m fade", register: "hypothetical" });
  });
});

// ---------------------------------------------------------------------------
// event bands
// ---------------------------------------------------------------------------
//
// A band claims a span of wall-clock time. What is pinned here is the
// placement only: clipping at both edges, the wholly-outside drop, and the
// visible minimum a zero-width occurrence still gets.

describe("computeChartGeometry: event bands", () => {
  const base = 1_700_000_000_000;
  const candles = fiveWalkingCandles();
  // Five candles spaced a minute apart, no clock: timeStart is the first
  // open, timeEnd the last, and the whole plot spans four minutes.
  const first = base;
  const last = base + 4 * 60_000;

  const bandAt = (startAt: number, endAt: number, upcoming = false) => ({
    key: `band-${startAt}`,
    label: "Devcon",
    startAt,
    endAt,
    upcoming,
  });

  const geometryWith = (bands: ReadonlyArray<ReturnType<typeof bandAt>>) =>
    computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
      eventBands: bands,
    });

  it("clips a band that overhangs the left edge, keeping its right edge", () => {
    // Half the span is before the window; the visible half must keep its
    // honest width rather than being pinned to a marker-thin sliver.
    const geometry = geometryWith([bandAt(first - 120_000, first + 60_000)]);
    expect(geometry?.timeBands).toHaveLength(1);
    const band = geometry?.timeBands[0];
    // Clipped at the reserved lane's far edge — the plot's left, not the
    // frame's.
    expect(band?.x1).toBe(LEFT_AXIS_LANE_WIDTH);
    expect(band?.x2).toBeGreaterThan(MIN_EVENT_BAND_WIDTH);
    expect(band?.width).toBe((band?.x2 ?? 0) - LEFT_AXIS_LANE_WIDTH);
  });

  it("drops a band wholly outside the plot rather than pinning it", () => {
    const geometry = geometryWith([bandAt(last + 60_000, last + 120_000)]);
    expect(geometry?.timeBands).toHaveLength(0);
  });

  it("gives a zero-width occurrence the visible minimum", () => {
    const geometry = geometryWith([bandAt(base + 120_000, base + 120_000)]);
    expect(geometry?.timeBands).toHaveLength(1);
    const band = geometry?.timeBands[0];
    expect(band?.width).toBe(MIN_EVENT_BAND_WIDTH);
  });

  it("keeps every field the renderer labels the band by", () => {
    const geometry = geometryWith([bandAt(base + 60_000, base + 120_000, true)]);
    const band = geometry?.timeBands[0];
    expect(band?.key).toBe(`band-${base + 60_000}`);
    expect(band?.label).toBe("Devcon");
    expect(band?.upcoming).toBe(true);
    expect(band?.startAt).toBe(base + 60_000);
    expect(band?.endAt).toBe(base + 120_000);
  });

  it("clamps an upcoming band into the future gutter when a clock is running", () => {
    const nowMillis = base + 4 * 60_000;
    const geometry = computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: 102,
      nowMillis,
      // Far beyond the gutter: pinned at the plot's right edge, visibly.
      eventBands: [bandAt(base + 30 * 60_000, base + 31 * 60_000, true)],
    });
    const band = geometry?.timeBands[0];
    expect(band).toBeDefined();
    expect(band?.x1).toBeGreaterThanOrEqual(geometry?.nowX ?? 0);
    expect(band?.width).toBeGreaterThanOrEqual(MIN_EVENT_BAND_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// the research study overlay
// ---------------------------------------------------------------------------

// What is pinned here is placement only: the rule and the two markers land at
// their own time and price, the connector joins the placed pair, and anything
// the window cannot hold honestly is dropped rather than pinned. The overlay
// is its own vocabulary: none of it is a fill.

describe("computeChartGeometry: the study overlay", () => {
  const base = 1_700_000_000_000;
  const candles = fiveWalkingCandles();
  // No clock: the plot spans the five bars, first open to last open.
  const first = base;
  const last = base + 4 * 60_000;

  const geometryWith = (studyOverlay: ChartStudyOverlayInput | null) =>
    computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
      studyOverlay,
    });

  it("places the activation rule and both markers at their own time and price", () => {
    const geometry = geometryWith({
      activation: { at: base + 30_000, label: "Merge / Paris" },
      entry: { at: base + 60_000, price: 100, label: "study entry" },
      exit: { at: base + 3 * 60_000, price: 103, label: "study exit after 30 bars" },
      returnPct: 3,
    });
    const overlay = geometry?.studyOverlay;
    expect(overlay).not.toBeNull();
    expect(overlay?.activation?.label).toBe("Merge / Paris");
    // Positions as fractions along the PLOT — [plotLeft, PLOT_WIDTH], the
    // lane no longer part of the axis — so the pinned fact is "its own time"
    // rather than one coordinate pair per constant.
    const alongPlot = (x: number): number =>
      (x - geometry!.plotLeft) / (PLOT_WIDTH - geometry!.plotLeft);
    expect(alongPlot(overlay!.activation!.x)).toBeCloseTo(30_000 / 240_000, 5);
    expect(alongPlot(overlay!.entry!.x)).toBeCloseTo(60_000 / 240_000, 5);
    expect(overlay?.entry?.y).toBeCloseTo(geometry!.yForPrice(100), 8);
    expect(alongPlot(overlay!.exit!.x)).toBeCloseTo(180_000 / 240_000, 5);
    expect(overlay?.exit?.y).toBeCloseTo(geometry!.yForPrice(103), 8);
    // The connector joins exactly the placed markers, in order.
    expect(overlay?.returnSpan).toEqual({
      x1: overlay!.entry!.x,
      y1: overlay!.entry!.y,
      x2: overlay!.exit!.x,
      y2: overlay!.exit!.y,
      returnPct: 3,
    });
  });

  it("orders the rule before the entry before the exit on the time axis", () => {
    const geometry = geometryWith({
      activation: { at: first, label: "Pectra" },
      entry: { at: base + 60_000, price: 100, label: "study entry" },
      exit: { at: last, price: 104, label: "study exit after 30 bars" },
      returnPct: 4,
    });
    const overlay = geometry?.studyOverlay;
    expect(overlay!.activation!.x).toBeLessThan(overlay!.entry!.x);
    expect(overlay!.entry!.x).toBeLessThan(overlay!.exit!.x);
  });

  it("drops an activation the window cannot see, like an old fill, never pins it", () => {
    const geometry = geometryWith({
      activation: { at: first - 1, label: "before the window" },
      entry: { at: base + 60_000, price: 100, label: "study entry" },
      exit: { at: last, price: 104, label: "study exit after 30 bars" },
      returnPct: 4,
    });
    expect(geometry?.studyOverlay?.activation).toBeNull();
    // The measured markers still draw: the rule is context, they are the
    // study.
    expect(geometry?.studyOverlay?.entry).not.toBeNull();
  });

  it("clamps a marker past the right edge to the plot's edge, keeping its true price", () => {
    // The close basis's exit is the exit bar's close, which lands after the
    // last open the axis ends on: pinned at the edge, price untouched.
    const geometry = geometryWith({
      activation: { at: base + 30_000, label: "Dencun" },
      entry: { at: base + 60_000, price: 100, label: "study entry" },
      exit: { at: last + 60_000, price: 104, label: "study exit after 30 bars" },
      returnPct: 4,
    });
    const exit = geometry?.studyOverlay?.exit;
    expect(exit?.x).toBe(PLOT_WIDTH);
    expect(exit?.price).toBe(104);
    expect(exit?.y).toBeCloseTo(geometry!.yForPrice(104), 8);
  });

  it("draws no connector when one end of the study is missing", () => {
    const geometry = geometryWith({
      activation: { at: base + 30_000, label: "Shapella" },
      entry: null,
      exit: { at: last, price: 104, label: "study exit after 30 bars" },
      returnPct: null,
    });
    expect(geometry?.studyOverlay?.returnSpan).toBeNull();
  });

  it("is null when the caller passed none, and pieces drop before the window", () => {
    expect(geometryWith(null)?.studyOverlay).toBeNull();
    const geometry = geometryWith({
      activation: { at: base + 30_000, label: "Pectra" },
      entry: { at: first - 1, price: 100, label: "study entry" },
      exit: null,
      returnPct: null,
    });
    expect(geometry?.studyOverlay?.entry).toBeNull();
    expect(geometry?.studyOverlay?.returnSpan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the unified left-axis lane
// ---------------------------------------------------------------------------
//
// What was broken: the grid prices and the session levels were placed by two
// independent passes, each internally consistent, printing on top of each
// other at the same left edge. What is pinned here is the ONE pass that
// replaces them: separation always holds, priority decides who moves, a
// label that cannot be placed is suppressed (never overlapped, and never its
// rule), duplicate visible text collapses, and nudging stays bounded.

describe("layoutLeftAxisLabels", () => {
  const frameHeight = 160;
  const minSeparation = 12; // a 10px line plus leading, at a 1:1 frame
  const layout = (entries: ReadonlyArray<LeftAxisLabelEntry>) =>
    layoutLeftAxisLabels({
      entries,
      frameHeight,
      minSeparation,
      maxNudge: minSeparation,
    });

  const pairwiseSeparation = (ys: ReadonlyArray<number>): number => {
    let smallest = Number.POSITIVE_INFINITY;
    for (let i = 1; i < ys.length; i += 1) {
      smallest = Math.min(smallest, ys[i]! - ys[i - 1]!);
    }
    return smallest;
  };

  it("holds the screenshot's density: 5 grid ticks and 7 session levels in 160 units", () => {
    // The collision the screenshot showed: a full grid plus every session
    // level fighting for one left edge. Whatever survives must be legible.
    const result = layout([
      // 7 session levels, several nearly coincident.
      { id: "session-pdh", text: "pd hi 2,461", y: 12, priority: 1 },
      { id: "session-vwap", text: "vwap 2,431", y: 31, priority: 1 },
      { id: "session-do", text: "d op 2,431", y: 32, priority: 1 },
      { id: "session-dh", text: "d hi 2,437", y: 40, priority: 1 },
      { id: "session-dl", text: "d lo 2,404", y: 96, priority: 1 },
      { id: "session-pdc", text: "pd cl 2,419", y: 118, priority: 1 },
      { id: "session-pdl", text: "pd lo 2,384", y: 149, priority: 1 },
      // 5 ordinary grid ticks.
      { id: "grid-a", text: "2,380", y: 8, priority: 2 },
      { id: "grid-b", text: "2,400", y: 44, priority: 2 },
      { id: "grid-c", text: "2,420", y: 80, priority: 2 },
      { id: "grid-d", text: "2,440", y: 116, priority: 2 },
      { id: "grid-e", text: "2,460", y: 152, priority: 2 },
    ]);

    const ys = result.placed.map((placement) => placement.y);
    expect(ys.length).toBeGreaterThan(0);
    expect(pairwiseSeparation([...ys].sort((a, b) => a - b))).toBeGreaterThanOrEqual(
      minSeparation - 1e-6,
    );
    // At this density something has to give, and what gives is the grid:
    // ticks are suppressed rather than overlapped or moved onto a session.
    expect(result.placed.some((placement) => placement.id.startsWith("grid-"))).toBe(true);
    expect(result.suppressed.size).toBeGreaterThan(0);
    for (const placement of result.placed) {
      expect(placement.y).toBeGreaterThanOrEqual(minSeparation / 2);
      expect(placement.y).toBeLessThanOrEqual(frameHeight - minSeparation / 2);
    }
    // Whatever the lane folded away is DISCLOSED, not dropped: every overflow
    // entry is a suppressed entry with its own readable text, and the lane
    // never collapses to nothing.
    expect(result.overflow.length).toBeGreaterThan(0);
    for (const entry of result.overflow) {
      expect(result.suppressed.has(entry.id)).toBe(true);
      expect(entry.text.length).toBeGreaterThan(0);
    }
    expect(result.placed.some((placement) => placement.id.startsWith("session-"))).toBe(true);
  });

  it("keeps every placed label within one nudge of its own rule", () => {
    const entries: LeftAxisLabelEntry[] = [
      { id: "session-a", text: "a", y: 60, priority: 1 },
      { id: "session-b", text: "b", y: 62, priority: 1 },
      { id: "grid-a", text: "1", y: 61, priority: 2 },
      { id: "grid-b", text: "2", y: 130, priority: 2 },
    ];
    const result = layout(entries);
    const trueY = new Map(entries.map((entry) => [entry.id, entry.y]));
    for (const placement of result.placed) {
      expect(Math.abs(placement.y - trueY.get(placement.id)!)).toBeLessThanOrEqual(
        minSeparation + 1e-6,
      );
    }
  });

  it("holds the priority order: drag readout > session level > grid tick", () => {
    // Three labels within a hair of each other: the dragged price keeps its
    // exact y, the session level moves clear, and the near-equal tick folds
    // under the session — its price is printed there, so it is suppressed
    // without being overflow.
    const result = layout([
      { id: "drag-readout", text: "2,420.25", y: 80, priority: 0 },
      { id: "session-vwap", text: "vwap 2,420.5", y: 82, priority: 1 },
      { id: "grid-a", text: "2,420", y: 84, priority: 2 },
    ]);
    expect(result.placed.find((placement) => placement.id === "drag-readout")?.y).toBe(80);
    const session = result.placed.find((placement) => placement.id === "session-vwap");
    expect(session).toBeDefined();
    expect(Math.abs(session!.y - 80)).toBeGreaterThanOrEqual(minSeparation - 1e-6);
    // The tick cannot sit legibly beside the level it is priced at: folded
    // into the level's label, hidden without being overflow — and its rule is
    // the renderer's business, untouched.
    expect(result.suppressed.has("grid-a")).toBe(true);
    expect(result.placed.find((placement) => placement.id === "grid-a")).toBeUndefined();
    expect(result.overflow.map((entry) => entry.id)).not.toContain("grid-a");
  });

  it("merges a tick a hair beneath the level, and nudges a genuinely separate one clear", () => {
    // Two units apart (the screenshot's 2,461-over-2,460): one label — the
    // named level, at its own y.
    const folded = layout([
      { id: "session-pdc", text: "pd cl 2,419", y: 40, priority: 1 },
      { id: "grid-a", text: "2,420", y: 42, priority: 2 },
    ]);
    expect(folded.placed.find((placement) => placement.id === "session-pdc")?.y).toBe(40);
    expect(folded.placed.find((placement) => placement.id === "grid-a")).toBeUndefined();
    expect(folded.overflow).toEqual([]);

    // Six apart: two honest facts, so the level holds its ground exactly and
    // the tick is the one that moves clear.
    const apart = layout([
      { id: "session-pdc", text: "pd cl 2,419", y: 40, priority: 1 },
      { id: "grid-a", text: "2,420", y: 46, priority: 2 },
    ]);
    expect(apart.placed.find((placement) => placement.id === "session-pdc")?.y).toBe(40);
    const grid = apart.placed.find((placement) => placement.id === "grid-a");
    expect(grid).toBeDefined();
    expect(grid!.y - 40).toBeGreaterThanOrEqual(minSeparation - 1e-6);
  });

  it("suppresses a tick boxed between two levels rather than overlapping either", () => {
    const result = layout([
      { id: "session-a", text: "a", y: 40, priority: 1 },
      { id: "session-b", text: "b", y: 52, priority: 1 },
      { id: "grid-a", text: "1", y: 46, priority: 2 },
    ]);
    // Both levels hold their ground exactly a separation apart; the tick in
    // the gap has nowhere legible to go within its nudge.
    expect(result.placed.find((placement) => placement.id === "session-a")?.y).toBe(40);
    expect(result.placed.find((placement) => placement.id === "session-b")?.y).toBe(52);
    expect(result.suppressed.has("grid-a")).toBe(true);
  });

  it("deduplicates equal or near-equal visible text into one label", () => {
    // Two ticks whose formatted prices print identically are one fact.
    const sameText = layout([
      { id: "grid-a", text: "2,420", y: 40, priority: 2 },
      { id: "grid-b", text: "2,420", y: 40.5, priority: 2 },
    ]);
    expect(sameText.placed).toHaveLength(1);
    expect(sameText.placed[0]!.y).toBe(40);
    expect(sameText.suppressed.has("grid-b")).toBe(true);

    // The more important entry's position wins the shared text.
    const crossKind = layout([
      { id: "session-pdc", text: "2,420", y: 40, priority: 1 },
      { id: "grid-a", text: "2,420", y: 41, priority: 2 },
    ]);
    expect(crossKind.placed).toHaveLength(1);
    expect(crossKind.placed[0]!.id).toBe("session-pdc");
    expect(crossKind.suppressed.has("grid-a")).toBe(true);
  });

  it("leaves an empty lane empty", () => {
    const result = layout([]);
    expect(result.placed).toEqual([]);
    expect(result.suppressed.size).toBe(0);
    expect(result.overflow).toEqual([]);
  });

  it("merges a near-value grid tick under the named level — one label, no overflow", () => {
    // The screenshot's pair: a session level at 2,461 with the grid's 2,460 a
    // hair beneath it. One label survives — the named one, at its own y — and
    // the folded tick is NOT overflow: its price is printed on the axis under
    // the label that won.
    const result = layout([
      { id: "session-pdh", text: "pd hi 2,461", y: 40, priority: 1 },
      { id: "grid-a", text: "2,460", y: 41, priority: 2 },
    ]);
    expect(result.placed).toHaveLength(1);
    expect(result.placed[0]).toMatchObject({ id: "session-pdh", y: 40 });
    expect(result.suppressed.has("grid-a")).toBe(true);
    expect(result.overflow).toEqual([]);
  });

  it("counts a folded same-kind level as overflow — its fact is printed nowhere", () => {
    // vwap and the day's open a few cents apart: the lane keeps one label,
    // but the loser's NAME is absent from the axis entirely, so it is
    // disclosed in the count rather than silently absorbed.
    const result = layout([
      { id: "session-vwap", text: "vwap 2,431", y: 31, priority: 1 },
      { id: "session-do", text: "d op 2,431", y: 31.2, priority: 1 },
    ]);
    expect(result.placed).toHaveLength(1);
    expect(result.placed[0]!.id).toBe("session-vwap");
    expect(result.overflow.map((entry) => entry.id)).toEqual(["session-do"]);
    expect(result.suppressed.has("session-do")).toBe(true);
  });

  it("keeps two honestly different prices two labels", () => {
    const gap = minSeparation * LEFT_AXIS_MERGE_DISTANCE_RATIO + 1;
    const result = layout([
      { id: "session-a", text: "a", y: 40, priority: 1 },
      { id: "grid-a", text: "1", y: 40 + gap, priority: 2 },
    ]);
    expect(result.placed).toHaveLength(2);
    expect(result.overflow).toEqual([]);
  });

  it("never lets the dragged readout swallow a named level by merging", () => {
    // The readout is a pointer read, not an axis fact: dragging across a
    // session level must nudge the level's label clear, not fold it away.
    const result = layout([
      { id: "drag-readout", text: "2,420.25", y: 80, priority: 0 },
      { id: "session-vwap", text: "vwap 2,420.5", y: 80.5, priority: 1 },
    ]);
    expect(result.placed).toHaveLength(2);
    expect(result.placed.find((placement) => placement.id === "drag-readout")?.y).toBe(80);
    expect(result.overflow).toEqual([]);
  });

  it("never hides the lane's most important named level, however boxed", () => {
    // Pathological piles: whatever else the lane does, the first named level
    // in priority order is placed — an axis that hides every level it names
    // has stopped being an axis.
    const fixtures: ReadonlyArray<ReadonlyArray<LeftAxisLabelEntry>> = [
      [
        { id: "drag-readout", text: "2,420.25", y: 154, priority: 0 },
        { id: "session-a", text: "a", y: 153, priority: 1 },
        { id: "session-b", text: "b", y: 141, priority: 1 },
      ],
      [
        { id: "drag-readout", text: "2,420.25", y: 80, priority: 0 },
        { id: "session-a", text: "a", y: 80.5, priority: 1 },
        { id: "grid-a", text: "1", y: 79.5, priority: 2 },
      ],
      [
        { id: "drag-readout", text: "2,420.25", y: 6, priority: 0 },
        { id: "session-a", text: "a", y: 7, priority: 1 },
        { id: "grid-a", text: "1", y: 5, priority: 2 },
      ],
    ];
    for (const entries of fixtures) {
      const result = layout(entries);
      const mostImportantNamed = [...entries]
        .filter((entry) => entry.priority >= 1)
        .sort((a, b) => a.priority - b.priority || a.y - b.y || a.id.localeCompare(b.id))[0]!;
      expect(result.placed.some((placement) => placement.id === mostImportantNamed.id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// the reserved left-axis lane (computeChartGeometry)
// ---------------------------------------------------------------------------
//
// The lane is ground the geometry HOLDS EMPTY: the plot's x-range is
// [plotLeft, PLOT_WIDTH], so candles, lines and rules begin at the lane's far
// edge, and the labels the lane layout places render inside [0, plotLeft].
// Both halves of that exclusion are pinned here.

describe("computeChartGeometry — the reserved left-axis lane", () => {
  const candles = fiveWalkingCandles();
  const base = {
    candles,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    liquidationPrice: null,
    entryTime: null,
    markPrice: 104,
  } as const;

  it("reserves the default lane and starts every drawn thing at its far edge", () => {
    const geometry = computeChartGeometry(base);
    if (geometry === null) throw new Error("expected geometry");
    expect(geometry.plotLeft).toBe(LEFT_AXIS_LANE_WIDTH);
    expect(geometry.xForTime(geometry.timeStart)).toBeCloseTo(LEFT_AXIS_LANE_WIDTH, 6);
    // Bars sit at their own times: a centre left of the lane edge is a bar
    // drawn inside the lane. The one allowance is the window-edge bar, whose
    // BODY may overhang half a width into the clip the renderer holds at the
    // lane edge (the same sliver the old viewBox edge used to clip at x=0).
    for (const bar of geometry.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(LEFT_AXIS_LANE_WIDTH - 1e-6);
      if (bar.x - bar.halfWidth < LEFT_AXIS_LANE_WIDTH - 1e-6) {
        expect(bar.x).toBeCloseTo(LEFT_AXIS_LANE_WIDTH, 6);
      }
    }
    for (const point of [...geometry.preEntryPoints, ...geometry.postEntryPoints]) {
      expect(point.x).toBeGreaterThanOrEqual(LEFT_AXIS_LANE_WIDTH - 1e-6);
    }
  });

  it("honours the renderer's narrow-frame lane and still excludes it", () => {
    // What the renderer passes on a ~360px frame: the 84px label floor
    // converted into viewBox units. The plot narrows; the exclusion does not.
    const lane = LEFT_AXIS_LABEL_MIN_WIDTH_PX * (1000 / 360);
    const geometry = computeChartGeometry({ ...base, leftAxisLaneWidth: lane });
    if (geometry === null) throw new Error("expected geometry");
    expect(geometry.plotLeft).toBeCloseTo(lane, 6);
    for (const bar of geometry.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(lane - 1e-6);
      if (bar.x - bar.halfWidth < lane - 1e-6) {
        expect(bar.x).toBeCloseTo(lane, 6);
      }
    }
    for (const point of [...geometry.preEntryPoints, ...geometry.postEntryPoints]) {
      expect(point.x).toBeGreaterThanOrEqual(lane - 1e-6);
    }
    // With a clock, the future gutter still shrinks the axis to the lane's
    // right, composed with the lane rather than against it.
    const withClock = computeChartGeometry({
      ...base,
      leftAxisLaneWidth: lane,
      nowMillis: candles[candles.length - 1]!.openTime + 30_000,
    });
    if (withClock === null) throw new Error("expected geometry");
    const expectedAxisEnd = lane + (PLOT_WIDTH - lane) * (1 - FUTURE_GUTTER_RATIO);
    expect(withClock.xForTime(withClock.timeEnd)).toBeCloseTo(expectedAxisEnd, 6);
    expect(withClock.nowX).toBeGreaterThan(lane);
    expect(withClock.nowX).toBeLessThan(expectedAxisEnd);
  });

  it("clamps a nonsensical lane request rather than trusting it", () => {
    const nan = computeChartGeometry({ ...base, leftAxisLaneWidth: Number.NaN });
    expect(nan?.plotLeft).toBe(LEFT_AXIS_LANE_WIDTH);
    const negative = computeChartGeometry({ ...base, leftAxisLaneWidth: -5 });
    expect(negative?.plotLeft).toBe(LEFT_AXIS_LANE_WIDTH);
    // A lane wider than the plot itself is a caller error: held to two fifths
    // so the plot keeps a majority of its width.
    const huge = computeChartGeometry({ ...base, leftAxisLaneWidth: 900 });
    expect(huge?.plotLeft).toBe(PLOT_WIDTH * 0.4);
  });

  it("keeps every lane label's modelled x-extent inside the reserved lane", () => {
    // Labels right-align against the lane's far edge, so a label's extent is
    // [plotLeft - width, plotLeft] and containment is one inequality per
    // label — pinned per placed label, not assumed from the constant.
    const geometry = computeChartGeometry(base);
    if (geometry === null) throw new Error("expected geometry");
    const lane = geometry.plotLeft;
    const entries: LeftAxisLabelEntry[] = [
      { id: "session-pdh", text: "pd hi 2,461", y: 12, priority: 1 },
      { id: "session-vwap", text: "vwap 2,431", y: 31, priority: 1 },
      { id: "session-do", text: "d op 2,431", y: 32, priority: 1 },
      { id: "session-pdl", text: "pd lo 2,384", y: 149, priority: 1 },
      { id: "grid-a", text: "2,380", y: 8, priority: 2 },
      { id: "grid-b", text: "2,400", y: 44, priority: 2 },
      { id: "grid-c", text: "2,420", y: 80, priority: 2 },
    ];
    const result = layoutLeftAxisLabels({
      entries,
      frameHeight: CHART_VIEWBOX_HEIGHT,
      minSeparation: 12,
      maxNudge: 12,
    });
    const textById = new Map(entries.map((entry) => [entry.id, entry.text]));
    for (const placement of result.placed) {
      const text = textById.get(placement.id);
      expect(text).toBeDefined();
      const width = leftAxisLabelWidth(text!);
      const left = lane - width;
      expect(left).toBeGreaterThanOrEqual(-1e-6);
      expect(lane).toBeLessThanOrEqual(PLOT_WIDTH);
    }
  });

  it("models the default lane wide enough for the longest label it draws", () => {
    // A session label is the lane's longest text: a two-word level name plus
    // a grouped price at full two-decimal precision.
    const longest = "pd cl 2,431.25";
    expect(leftAxisLabelWidth(longest)).toBeLessThanOrEqual(LEFT_AXIS_LANE_WIDTH);
    expect(leftAxisLabelWidth("")).toBeGreaterThan(0);
    expect(LEFT_AXIS_LABEL_CHAR_WIDTH).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// grid precision and tick count
// ---------------------------------------------------------------------------

describe("gridPriceDecimals", () => {
  it("picks the coarsest decimals the tick spacing supports", () => {
    expect(gridPriceDecimals(50)).toBe(0);
    expect(gridPriceDecimals(10)).toBe(0);
    expect(gridPriceDecimals(2.5)).toBe(1);
    expect(gridPriceDecimals(0.5)).toBe(1);
    expect(gridPriceDecimals(0.25)).toBe(2);
    expect(gridPriceDecimals(0.01)).toBe(2);
    expect(gridPriceDecimals(0.000002)).toBe(6);
  });

  it("falls back to two decimals for a step it cannot read", () => {
    expect(gridPriceDecimals(0)).toBe(2);
    expect(gridPriceDecimals(-1)).toBe(2);
    expect(gridPriceDecimals(Number.NaN)).toBe(2);
  });
});

describe("formatGridPrice", () => {
  // The grouping separator follows the runtime locale; the precision must not.
  it("prints each spacing at its own precision, without mixing", () => {
    expect(formatGridPrice(2420, 0)).toMatch(/2[.,]420$/);
    expect(formatGridPrice(2420.5, 1)).toMatch(/2[.,]420\.5$/);
    expect(formatGridPrice(2420.51, 2)).toMatch(/2[.,]420\.51$/);
    expect(formatGridPrice(2420.5, 1)).not.toContain("51");
  });
});

describe("gridTickTarget", () => {
  it("reduces the tick count on narrow frames before any type shrinks", () => {
    // The font sizes are constants of the chart (10px/9px); the ONLY lever
    // the measured width pulls is how many rules are drawn.
    expect(gridTickTarget(900)).toBe(4);
    expect(gridTickTarget(560)).toBe(4);
    expect(gridTickTarget(559)).toBe(3);
    expect(gridTickTarget(360)).toBe(3);
    expect(gridTickTarget(359)).toBe(2);
  });

  it("defaults to the full count unmeasured", () => {
    expect(gridTickTarget(0)).toBe(4);
    expect(gridTickTarget(Number.NaN)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// research markers
// ---------------------------------------------------------------------------
//
// One researched event occurrence from a published scene, placed on the time
// axis: an instantaneous activation is a rule at its EXACT saved millisecond
// (never moved for collisions — only labels stack), a genuine span is a band,
// an uncovered occurrence draws nothing at all, and an upcoming one follows
// the bounded future-gutter policy.

describe("computeChartGeometry: research markers", () => {
  const base = 1_700_000_000_000;
  const candles = fiveWalkingCandles();
  // Five candles spaced a minute apart, no clock: the whole plot spans the
  // four minutes from the first open to the last.
  const first = base;
  const last = base + 4 * 60_000;

  const markerInput = (overrides: Partial<ChartResearchMarkerInput>): ChartResearchMarkerInput => ({
    key: "research-1",
    label: "Dencun",
    startAt: base + 120_000,
    endAt: base + 120_000,
    sourceUrl: "https://ethereum.org/en/roadmap/dencun",
    covered: true,
    upcoming: false,
    ...overrides,
  });

  const geometryWith = (
    markers: ReadonlyArray<ChartResearchMarkerInput>,
    extra: { readonly nowMillis?: number } = {},
  ) =>
    computeChartGeometry({
      candles,
      entryPrice: null,
      stopPrice: null,
      targetPrice: null,
      liquidationPrice: null,
      entryTime: null,
      markPrice: null,
      researchMarkers: markers,
      ...extra,
    });

  it("rules an instantaneous occurrence at the exact millisecond it saved", () => {
    const geometry = geometryWith([markerInput({})]);
    expect(geometry?.researchMarkers).toHaveLength(1);
    const marker = geometry?.researchMarkers[0];
    expect(marker?.span).toBe(false);
    // The rule's x is the projection of the instant itself — to the exact
    // float, never rounded to a bar or nudged for collisions.
    expect(marker?.x1).toBe(geometry!.xForTime(base + 120_000));
    expect(marker?.x2).toBe(marker?.x1);
  });

  it("bands a genuine span across its own start and end", () => {
    const geometry = geometryWith([markerInput({ startAt: base + 60_000, endAt: base + 150_000 })]);
    const marker = geometry?.researchMarkers[0];
    expect(marker?.span).toBe(true);
    expect(marker?.x1).toBeCloseTo(geometry!.xForTime(base + 60_000), 5);
    expect(marker?.x2).toBeCloseTo(geometry!.xForTime(base + 150_000), 5);
    expect(marker!.x2 - marker!.x1).toBeGreaterThanOrEqual(MIN_EVENT_BAND_WIDTH);
  });

  it("draws nothing for an uncovered occurrence — no rule, no band, no left-edge pin", () => {
    const geometry = geometryWith([
      markerInput({ covered: false, startAt: base + 60_000, endAt: base + 150_000 }),
    ]);
    expect(geometry?.researchMarkers).toHaveLength(0);
  });

  it("drops an occurrence from before the window like an old fill", () => {
    const geometry = geometryWith([markerInput({ startAt: first - 1, endAt: first - 1 })]);
    expect(geometry?.researchMarkers).toHaveLength(0);
  });

  it("clamps an upcoming occurrence into the future gutter, never beyond it", () => {
    const nowMillis = last;
    const geometry = geometryWith(
      [
        // Far beyond the gutter: pinned at its far edge, visibly.
        markerInput({ startAt: base + 30 * 60_000, endAt: base + 31 * 60_000, upcoming: true }),
      ],
      { nowMillis },
    );
    const marker = geometry?.researchMarkers[0];
    expect(marker).toBeDefined();
    expect(marker?.upcoming).toBe(true);
    expect(marker?.x1).toBeGreaterThanOrEqual(geometry?.nowX ?? 0);
    expect(marker?.x1).toBeLessThanOrEqual(PLOT_WIDTH);
    // Pinned at the gutter's far edge, the visible-minimum floor must not
    // push the band past the plot and into the price gutter.
    expect(marker?.x2).toBeLessThanOrEqual(PLOT_WIDTH);
    expect(marker!.x2 - marker!.x1).toBeGreaterThanOrEqual(MIN_EVENT_BAND_WIDTH);
  });

  it("draws no upcoming occurrence without a clock — there is no gutter to hold it", () => {
    const geometry = geometryWith([markerInput({ upcoming: true })]);
    expect(geometry?.researchMarkers).toHaveLength(0);
  });

  it("stacks the labels of close occurrences in rows while the rules keep their x", () => {
    // Two activations seconds apart: their labels cannot share one row, but
    // neither rule moves a hair.
    const nearA = base + 120_000;
    const nearB = base + 125_000;
    const geometry = geometryWith([
      markerInput({ key: "a", startAt: nearA, endAt: nearA }),
      markerInput({ key: "b", startAt: nearB, endAt: nearB }),
    ]);
    const a = geometry?.researchMarkers.find((marker) => marker.key === "a");
    const b = geometry?.researchMarkers.find((marker) => marker.key === "b");
    expect(a?.x1).toBe(geometry!.xForTime(nearA));
    expect(b?.x1).toBe(geometry!.xForTime(nearB));
    expect(Math.abs(b!.labelY - a!.labelY)).toBeGreaterThanOrEqual(RESEARCH_LABEL_ROW_STEP);

    // Far apart, the labels share the first row.
    const apart = geometryWith([
      markerInput({ key: "a", startAt: base + 60_000, endAt: base + 60_000 }),
      markerInput({ key: "b", startAt: base + 180_000, endAt: base + 180_000 }),
    ]);
    const apartA = apart?.researchMarkers.find((marker) => marker.key === "a");
    const apartB = apart?.researchMarkers.find((marker) => marker.key === "b");
    expect(apartA?.labelY).toBe(apartB?.labelY);
  });

  it("keeps every field the renderer labels the occurrence by", () => {
    const geometry = geometryWith([markerInput({})]);
    const marker = geometry?.researchMarkers[0];
    expect(marker?.key).toBe("research-1");
    expect(marker?.label).toBe("Dencun");
    expect(marker?.sourceUrl).toBe("https://ethereum.org/en/roadmap/dencun");
  });
});

describe("research marker disclosure", () => {
  // 2024-03-13 13:00:00 UTC — the instant the Dencun example names.
  const dencun = 1_710_334_800_000;

  it("formats the exact UTC date and time", () => {
    expect(formatUtcInstant(dencun)).toBe("2024-03-13 13:00 UTC");
    expect(formatUtcInstant(dencun + 15_000)).toBe("2024-03-13 13:00:15 UTC");
    expect(formatUtcInstant(Number.NaN)).toBe("");
  });

  it("accepts only http(s) sources as links", () => {
    expect(isHttpSourceUrl("https://ethereum.org/en/roadmap/dencun")).toBe(true);
    expect(isHttpSourceUrl("http://example.com")).toBe(true);
    expect(isHttpSourceUrl("ipfs://bafy...")).toBe(false);
    expect(isHttpSourceUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpSourceUrl("")).toBe(false);
  });

  it("carries the name, the exact instant, the not-a-trade wording, and the source", () => {
    const label = researchMarkerAriaLabel({
      label: "Dencun",
      startAt: dencun,
      sourceUrl: "https://ethereum.org/en/roadmap/dencun",
    });
    expect(label).toContain("Dencun");
    expect(label).toContain("2024-03-13 13:00 UTC");
    expect(label).toContain(RESEARCH_MARKER_NOTE);
    expect(label).toContain("https://ethereum.org/en/roadmap/dencun");
  });

  it("omits a non-http source rather than linking it", () => {
    const label = researchMarkerAriaLabel({
      label: "Dencun",
      startAt: dencun,
      sourceUrl: "ipfs://bafy...",
    });
    expect(label).toContain("Dencun");
    expect(label).not.toContain("ipfs");
  });
});
