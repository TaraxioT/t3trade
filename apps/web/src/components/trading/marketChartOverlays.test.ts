/**
 * The market chart's coverage/session overlay arithmetic (final-form phase 6).
 *
 * Two honesty rules are pinned here: a session level outside the price domain
 * is dropped rather than clamped to a wrong position, and coverage shading
 * covers exactly the stretches the archive does not vouch for — the head of
 * the window before recording started, plus its known gaps, clipped to the
 * window and never inverted.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  coverageBands,
  layoutSessionLabelYs,
  SESSION_LABEL_MIN_SEPARATION,
  sessionLevelLines,
} from "./marketChartOverlays";

describe("sessionLevelLines", () => {
  const levels = {
    priorDayHigh: 110,
    priorDayLow: 90,
    priorDayClose: 105,
    todayOpen: 104,
    todayHigh: 108,
    todayLow: 99,
    vwap: 103.5,
  };

  it("serves every level inside the domain, keyed and labeled", () => {
    const lines = sessionLevelLines(levels, 80, 120);
    expect(lines.map((line) => line.key)).toEqual(["pdh", "pdl", "pdc", "do", "dh", "dl", "vwap"]);
    expect(lines.find((line) => line.key === "vwap")?.price).toBe(103.5);
  });

  it("drops levels outside the domain instead of clamping them", () => {
    const lines = sessionLevelLines(levels, 100, 106);
    // 110, 90, 108 and 99 are outside [100, 106]; a clamped rule would sit at
    // a price its label does not say.
    expect(lines.map((line) => line.key)).toEqual(["pdc", "do", "vwap"]);
  });

  it("is empty with no levels at all", () => {
    expect(sessionLevelLines(undefined, 0, 1_000)).toEqual([]);
    expect(sessionLevelLines({}, 0, 1_000)).toEqual([]);
  });
});

describe("layoutSessionLabelYs", () => {
  const frameHeight = 160;

  it("leaves labels already far enough apart where they are", () => {
    const ys = layoutSessionLabelYs(
      [
        { key: "do", y: 20 },
        { key: "vwap", y: 80 },
      ],
      frameHeight,
    );
    expect(ys.get("do")).toBe(20);
    expect(ys.get("vwap")).toBe(80);
  });

  it("folds colliding labels apart by at least the minimum separation", () => {
    // "open 81.18" printed on "vwap 81.14" was the observed collision: two
    // levels a few cents apart land within a line of each other.
    const ys = layoutSessionLabelYs(
      [
        { key: "do", y: 70 },
        { key: "vwap", y: 72 },
        { key: "dh", y: 73 },
      ],
      frameHeight,
    );
    const placed = [ys.get("do")!, ys.get("vwap")!, ys.get("dh")!];
    expect(placed[1]! - placed[0]!).toBeGreaterThanOrEqual(SESSION_LABEL_MIN_SEPARATION);
    expect(placed[2]! - placed[1]!).toBeGreaterThanOrEqual(SESSION_LABEL_MIN_SEPARATION);
    // The cluster stays anchored at its own level, not pushed off elsewhere.
    expect(placed[0]).toBe(70);
  });

  it("keeps a cluster at the bottom edge inside the frame", () => {
    const ys = layoutSessionLabelYs(
      [
        { key: "dl", y: 158 },
        { key: "pdl", y: 159 },
      ],
      frameHeight,
    );
    const bottom = frameHeight - SESSION_LABEL_MIN_SEPARATION;
    expect(ys.get("pdl")).toBeLessThanOrEqual(bottom);
    expect(ys.get("pdl")! - ys.get("dl")!).toBeGreaterThanOrEqual(SESSION_LABEL_MIN_SEPARATION);
    expect(ys.get("dl")).toBeGreaterThanOrEqual(0);
  });

  it("is empty for no labels", () => {
    expect(layoutSessionLabelYs([], frameHeight).size).toBe(0);
  });
});

describe("coverageBands", () => {
  const timeStart = 1_000;
  const timeEnd = 2_000;

  it("shades the head of the window before recording started", () => {
    const bands = coverageBands({
      gaps: undefined,
      recordingSince: 1_400,
      timeStart,
      timeEnd,
    });
    expect(bands).toEqual([
      { key: "before-recording", fromT: 1_000, toT: 1_400, kind: "before_recording" },
    ]);
  });

  it("does not shade when recording predates the window", () => {
    expect(coverageBands({ gaps: undefined, recordingSince: 500, timeStart, timeEnd })).toEqual([]);
  });

  it("clips gaps to the window and drops the ones outside it", () => {
    const bands = coverageBands({
      gaps: [
        { fromT: 0, toT: 900 }, // entirely before: dropped
        { fromT: 900, toT: 1_200 }, // straddles the start: clipped
        { fromT: 1_500, toT: 1_600 }, // inside: kept whole
        { fromT: 1_900, toT: 3_000 }, // straddles the end: clipped
      ],
      recordingSince: undefined,
      timeStart,
      timeEnd,
    });
    expect(bands.map((band) => [band.fromT, band.toT])).toEqual([
      [1_000, 1_200],
      [1_500, 1_600],
      [1_900, 2_000],
    ]);
    expect(bands.every((band) => band.kind === "gap")).toBe(true);
  });

  it("serves nothing for an empty or inverted window", () => {
    expect(
      coverageBands({
        gaps: [{ fromT: 0, toT: 5_000 }],
        recordingSince: 1_500,
        timeStart: 2_000,
        timeEnd: 2_000,
      }),
    ).toEqual([]);
  });

  it("live-served series (no recordingSince, no gaps) shade nothing", () => {
    expect(
      coverageBands({ gaps: undefined, recordingSince: undefined, timeStart, timeEnd }),
    ).toEqual([]);
  });
});
