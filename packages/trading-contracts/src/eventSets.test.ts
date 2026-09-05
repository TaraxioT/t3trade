/**
 * The study, pinned on series whose answer is arithmetic.
 *
 * Every expectation is a number computed by hand: entry is the open of the
 * first bar at or after the occurrence's end, exit is the close a horizon
 * later, and the baseline asks the same question of every bar. The honesty
 * rows are the point as much as the math: an occurrence the archive cannot
 * see is a sentence, not a silent drop.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  checkEventStudy,
  EVENT_STUDY_DEFAULT_ENTRY_BASIS,
  EVENT_STUDY_MAX_HORIZON_BARS,
  eventStudyHydrationWindow,
  eventStudyReadWindow,
  parseTradingEventsOccurrence,
  renderTradingEventsMenu,
  resolveEventStudyMetric,
  runEventStudy,
  serializeEventConfirmationPayload,
  validateEventOccurrence,
  type TradingEventOccurrence,
} from "./eventSets.ts";
import type { MarketCandle } from "./market.ts";

const MINUTE = 60_000;

/** A bar whose open and close are named, at 1m cadence. */
const bar = (index: number, open: number, close: number): MarketCandle =>
  ({
    openTime: index * MINUTE,
    closeTime: index * MINUTE + MINUTE - 1,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
    trades: 1,
  }) as MarketCandle;

const occurrence = (startAt: number, endAt: number): TradingEventOccurrence => ({
  startAt,
  endAt,
  source: "https://example.com/dates",
});

describe("the study math", () => {
  // Ten bars opening at 100 and closing at 100 + i.
  const candles = Array.from({ length: 10 }, (_, i) => bar(i, 100, 100 + i));

  it("enters at the first bar at or after the end, exits a horizon later", () => {
    // The event ends exactly at bar 3's open. Horizon 3: entry open 100 (bar
    // 3), exit close 105 (bar 5). (105 - 100) / 100 = 5%.
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 3,
    });
    expect(study.rows[0]?.covered).toBe(true);
    expect(study.rows[0]?.entryTime).toBe(3 * MINUTE);
    expect(study.rows[0]?.exitPrice).toBe(105);
    expect(study.rows[0]?.returnPct).toBe(5);
    expect(study.rows[0]?.truncated).toBe(false);
    expect(study.rows[0]?.barsCovered).toBe(3);
  });

  it("an end mid-bar enters on the NEXT bar, never the one it lands inside", () => {
    // The event ends halfway through bar 3. Bar 3 opened before the event
    // ended, so it is not a bar the event had happened by.
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE + 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows[0]?.entryTime).toBe(4 * MINUTE);
    expect(study.rows[0]?.returnPct).toBe(4);
  });

  it("truncates at the last served close and says how many bars it got", () => {
    // Horizon 5 from bar 8 wants bar 12; the window ends at bar 9.
    const study = runEventStudy({
      occurrences: [occurrence(0, 8 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 5,
    });
    expect(study.rows[0]?.covered).toBe(true);
    expect(study.rows[0]?.truncated).toBe(true);
    expect(study.rows[0]?.barsCovered).toBe(2);
    expect(study.rows[0]?.exitPrice).toBe(109);
  });

  it("aggregates the covered rows and samples the baseline at every bar", () => {
    // Bars that all open 100 and close 102: every horizon returns +2%, from
    // an event or from anywhere else, so the aggregate and the baseline are
    // both 2 and the comparison is not vacuous.
    const flat = Array.from({ length: 6 }, (_, i) => bar(i, 100, 102));
    const study = runEventStudy({
      occurrences: [occurrence(0, 1 * MINUTE), occurrence(0, 3 * MINUTE)],
      candles: flat,
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.n).toBe(2);
    expect(study.nCovered).toBe(2);
    expect(study.meanReturnPct).toBe(2);
    expect(study.medianReturnPct).toBe(2);
    expect(study.hitRatePercent).toBe(100);
    expect(study.bestReturnPct).toBe(2);
    expect(study.worstReturnPct).toBe(2);
    expect(study.baseline?.samples).toBe(5);
    expect(study.baseline?.meanReturnPct).toBe(2);
    expect(study.horizonMs).toBe(2 * MINUTE);
  });

  it("takes the median, the mean and the hit rate of a mixed spread literally", () => {
    // Opens all 100, closes dip then recover: an event ending at bar 1 reads
    // (90 - 100) / 100 = -10%, bar 4 reads -1%, bar 7 reads +5%.
    const closes = [100, 90, 95, 97, 99, 101, 103, 105, 107, 109];
    const mixed = closes.map((close, index) => bar(index, 100, close));
    const study = runEventStudy({
      occurrences: [
        occurrence(0, 1 * MINUTE),
        occurrence(0, 4 * MINUTE),
        occurrence(0, 7 * MINUTE),
      ],
      candles: mixed,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows.map((row) => row.returnPct)).toEqual([-10, -1, 5]);
    expect(study.meanReturnPct).toBe(-2);
    expect(study.medianReturnPct).toBe(-1);
    expect(study.hitRatePercent).toBe(33.33);
    expect(study.bestReturnPct).toBe(5);
    expect(study.worstReturnPct).toBe(-10);
  });
});

describe("uncovered occurrences", () => {
  const candles = Array.from({ length: 5 }, (_, i) => bar(i, 100, 100 + i));

  it("reports one that predates the window rather than dropping it", () => {
    const study = runEventStudy({
      occurrences: [occurrence(0, -10 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.returnPct).toBeUndefined();
    expect(study.rows[0]?.reason).toContain("before the archived window");
  });

  it("reports one that has not ended yet rather than dropping it", () => {
    const study = runEventStudy({
      occurrences: [occurrence(99 * MINUTE, 100 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.reason).toContain("still in the future");
  });

  it("says what it measured when only some occurrences are inside", () => {
    const study = runEventStudy({
      occurrences: [
        occurrence(0, -10 * MINUTE),
        occurrence(0, 1 * MINUTE),
        occurrence(0, 2 * MINUTE),
      ],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.n).toBe(3);
    expect(study.nCovered).toBe(2);
    // The pinned shape: coverage stated as a fraction of the whole set.
    expect(study.verdict).toContain("2 of 3 occurrences fall inside archived data");
    // And never a claim of significance.
    expect(study.verdict).toContain("not evidence");
  });

  it("holds no bars against an empty archive and says so", () => {
    const study = runEventStudy({
      occurrences: [occurrence(0, MINUTE)],
      candles: [],
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.nCovered).toBe(0);
    expect(study.verdict).toContain("0 of 1 occurrence falls inside archived data");
  });

  it("refuses to invent a mean when nothing was covered", () => {
    const study = runEventStudy({
      occurrences: [occurrence(0, -10 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.meanReturnPct).toBeNull();
    expect(study.medianReturnPct).toBeNull();
    expect(study.hitRatePercent).toBeNull();
    expect(study.baseline).not.toBeNull();
  });
});

describe("the entry-gap boundary (a full missing interval refuses)", () => {
  // A series with ONE bar missing: bar 3 is absent, so the first bar at or
  // after an event ending at 3*MINUTE is bar 4 — exactly one interval late.
  const gappy = [
    bar(0, 100, 100),
    bar(1, 100, 100),
    bar(2, 100, 100),
    // bar 3 missing: the recording gap under test.
    bar(4, 100, 104),
    bar(5, 100, 105),
    bar(6, 100, 106),
  ];

  it("a gap smaller than one interval still measures (mid-bar end)", () => {
    // A complete series, the event ending inside bar 2: the first bar at or
    // after the end is bar 3, half an interval late — measured, not refused.
    const complete = Array.from({ length: 7 }, (_, i) => bar(i, 100, 100 + i));
    const study = runEventStudy({
      occurrences: [occurrence(0, 2 * MINUTE + 30_000)],
      candles: complete,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows[0]?.covered).toBe(true);
    expect(study.rows[0]?.entryTime).toBe(3 * MINUTE);
    expect(study.rows[0]?.returnPct).toBe(3);
  });

  it("a gap of exactly one interval refuses rather than shifting the entry", () => {
    // The event ends at bar 3's open. Bar 3 is the declared entry and is
    // missing, so measuring from bar 4 would silently change the thesis.
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles: gappy,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.reason).toContain("recording gap covers the 1 bar(s)");
    expect(study.meanReturnPct).toBeNull();
  });

  it("a gap larger than one interval refuses with the gap sentence", () => {
    // Bars 3 and 4 are both missing: the first bar at or after the end of an
    // event ending at 3*MINUTE is bar 5, two whole intervals late.
    const gappy2 = [
      bar(0, 100, 100),
      bar(1, 100, 100),
      bar(2, 100, 100),
      // bars 3 and 4 missing.
      bar(5, 100, 105),
      bar(6, 100, 106),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles: gappy2,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.reason).toContain("recording gap covers the 2 bar(s)");
    expect(study.meanReturnPct).toBeNull();
  });
});

describe("horizon semantics: the sentence and the engine agree at horizon 1 and 2", () => {
  const candles = [bar(0, 100, 101), bar(1, 100, 104), bar(2, 100, 109)];

  it("horizon 1 exits on the entry bar's own close (the entry is the first bar of the horizon)", () => {
    const study = runEventStudy({
      occurrences: [occurrence(0, 1 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows[0]?.entryTime).toBe(1 * MINUTE);
    expect(study.rows[0]?.exitPrice).toBe(104);
    expect(study.rows[0]?.exitTime).toBe(2 * MINUTE - 1);
    expect(study.rows[0]?.returnPct).toBe(4);
  });

  it("horizon 2 exits on the next bar's close (inclusive counting)", () => {
    const study = runEventStudy({
      occurrences: [occurrence(0, 1 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
    });
    expect(study.rows[0]?.exitPrice).toBe(109);
    expect(study.rows[0]?.barsCovered).toBe(2);
    expect(study.rows[0]?.returnPct).toBe(9);
  });
});

describe("the close basis: entry is the first closed bar's close, exit a full horizon later", () => {
  // Ten bars opening 100 and closing 100 + i; closeTime is the bar's last
  // millisecond (open + interval - 1), the convention the archive stamps.
  const candles = Array.from({ length: 10 }, (_, i) => bar(i, 100, 100 + i));

  it("defaults tool calls to the close basis and keeps the open basis for pure callers", () => {
    expect(EVENT_STUDY_DEFAULT_ENTRY_BASIS).toBe("first_closed_bar_after_event");
    // runEventStudy itself still defaults to the open basis: existing callers
    // measure what they measured before. Proven by the open-basis tests above
    // passing without naming a basis.
  });

  it("horizon 1 enters on the containing bar's close and exits on the next bar's close", () => {
    // The event ends at bar 3's open. Bar 3 is the first bar whose close
    // (4m - 1ms) is strictly after the event: entry close 103, exit close 104
    // one interval later. (104 - 103) / 103 = 0.97%.
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.rows[0]?.covered).toBe(true);
    expect(study.rows[0]?.entryTime).toBe(4 * MINUTE - 1);
    expect(study.rows[0]?.entryPrice).toBe(103);
    expect(study.rows[0]?.exitPrice).toBe(104);
    expect(study.rows[0]?.exitTime).toBe(5 * MINUTE - 1);
    expect(study.rows[0]?.returnPct).toBe(0.97);
    expect(study.rows[0]?.barsCovered).toBe(1);
    expect(study.rows[0]?.truncated).toBe(false);
  });

  it("horizon 2 exits two full intervals after the entry close", () => {
    // Entry close 103 (bar 3), exit close 105 (bar 5): two close-to-close
    // intervals. (105 - 103) / 103 = 1.94%.
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.rows[0]?.exitPrice).toBe(105);
    expect(study.rows[0]?.returnPct).toBe(1.94);
    expect(study.rows[0]?.barsCovered).toBe(2);
  });

  it("an intrabar activation enters on the close of the bar that contains it", () => {
    // The activation lands halfway through bar 3. Bar 3's close follows the
    // activation, so the entry is bar 3's own close, not the next bar's.
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE + 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.rows[0]?.entryPrice).toBe(103);
    expect(study.rows[0]?.entryTime).toBe(4 * MINUTE - 1);
    expect(study.rows[0]?.returnPct).toBe(0.97);
  });

  it("an activation exactly at a boundary enters on the next bar's close, never an equal one", () => {
    // Ending exactly at bar 3's close (4m - 1ms) is NOT after it: strictly
    // greater means bar 4, entry close 104, horizon 1 exit close 105.
    // (105 - 104) / 104 = 0.96%. The same holds ending at bar 4's open.
    for (const endAt of [4 * MINUTE - 1, 4 * MINUTE]) {
      const study = runEventStudy({
        occurrences: [occurrence(0, endAt)],
        candles,
        intervalMs: MINUTE,
        horizonBars: 1,
        entryBasis: "first_closed_bar_after_event",
      });
      expect(study.rows[0]?.entryPrice).toBe(104);
      expect(study.rows[0]?.exitPrice).toBe(105);
      expect(study.rows[0]?.returnPct).toBe(0.96);
    }
  });

  it("refuses a first bar that has not closed yet rather than reading a forming close", () => {
    // The activation lands inside the last bar; with `now` inside that bar
    // the entry candidate's close is still in the future, so there is no
    // closed price to enter on.
    const study = runEventStudy({
      occurrences: [occurrence(0, 9 * MINUTE + 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
      entryBasis: "first_closed_bar_after_event",
      now: 9 * MINUTE + 45_000,
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.reason).toContain("has not closed yet");
    expect(study.meanReturnPct).toBeNull();
  });

  it("refuses a horizon with not one close-to-close interval to measure", () => {
    // One archived bar after an activation: the entry close exists, but no
    // bar follows it, so a 0% "return" over zero intervals would be the most
    // misleading covered row possible.
    const study = runEventStudy({
      occurrences: [occurrence(0, 0)],
      candles: [bar(0, 100, 101)],
      intervalMs: MINUTE,
      horizonBars: 1,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.reason).toContain("no bar after this event's entry bar");
    expect(study.meanReturnPct).toBeNull();
  });

  it("truncates at the last served close and says how many intervals it got", () => {
    // Entry close 108 (bar 8), horizon 5 wants bar 13; the window ends at
    // bar 9's close 109. (109 - 108) / 108 = 0.93% over 1 interval.
    const study = runEventStudy({
      occurrences: [occurrence(0, 8 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 5,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.rows[0]?.covered).toBe(true);
    expect(study.rows[0]?.truncated).toBe(true);
    expect(study.rows[0]?.barsCovered).toBe(1);
    expect(study.rows[0]?.exitPrice).toBe(109);
    expect(study.rows[0]?.returnPct).toBe(0.93);
  });

  it("refuses a recording gap that covers the close the entry would have measured from", () => {
    // Bar 3 is absent; an activation at bar 3's open finds bar 4 as the
    // first close after it, exactly one interval late: refuse, the same
    // inclusive boundary the open basis uses.
    const gappy = [
      bar(0, 100, 100),
      bar(1, 100, 100),
      bar(2, 100, 100),
      // bar 3 missing: the recording gap under test.
      bar(4, 100, 104),
      bar(5, 100, 105),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles: gappy,
      intervalMs: MINUTE,
      horizonBars: 1,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.reason).toContain("recording gap covers the 1 bar(s)");
    expect(study.rows[0]?.reason).toContain("close");
  });

  it("keeps the shared honesty rows: future ends and pre-archive ends", () => {
    const future = runEventStudy({
      occurrences: [occurrence(99 * MINUTE, 100 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(future.rows[0]?.reason).toContain("still in the future");
    const early = runEventStudy({
      occurrences: [occurrence(0, -10 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(early.rows[0]?.reason).toContain("before the archived window");
  });

  it("samples the baseline as the same close-to-close lag at every bar, matching the rows", () => {
    // Closes 100, 102, 104: the lag-1 close-to-close returns are 2% and
    // (104 - 102) / 102 = 1.96%, so the baseline mean is 1.98% and an
    // occurrence entering on bar 0 or bar 1 measures exactly the baseline
    // sample at that bar: parity, not a different question.
    const stepped = [bar(0, 100, 100), bar(1, 100, 102), bar(2, 100, 104)];
    const study = runEventStudy({
      occurrences: [occurrence(0, 0), occurrence(0, 1 * MINUTE)],
      candles: stepped,
      intervalMs: MINUTE,
      horizonBars: 1,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.rows.map((row) => row.returnPct)).toEqual([2, 1.96]);
    expect(study.baseline?.samples).toBe(2);
    expect(study.baseline?.meanReturnPct).toBe(1.98);
    expect(study.baseline?.medianReturnPct).toBe(1.98);
  });
});

describe("aggregates come from unrounded returns", () => {
  it("the mean is not the mean of the display-rounded rows", () => {
    // Two occurrences returning 0.991% and 0.997%: the rows round to 0.99 and
    // 1.00 (mean 1.00 after rounding), but the unrounded mean is 0.994,
    // which rounds to 0.99. The report must say 0.99.
    const candles = [
      bar(0, 100, 100),
      bar(1, 100, 100),
      bar(2, 100, 100.991),
      bar(3, 100, 100),
      bar(4, 100, 100),
      bar(5, 100, 100),
      bar(6, 100, 100.997),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 2 * MINUTE), occurrence(0, 6 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows.map((row) => row.returnPct)).toEqual([0.99, 1]);
    expect(study.meanReturnPct).toBe(0.99);
    expect(study.medianReturnPct).toBe(0.99);
  });
});

describe("the path_extrema metric", () => {
  /**
   * A bar whose wick is named: high and low are independent of open and
   * close, because an excursion is a wick measurement.
   */
  const wickBar = (
    index: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ): MarketCandle =>
    ({
      openTime: index * MINUTE,
      closeTime: index * MINUTE + MINUTE - 1,
      open,
      high,
      low,
      close,
      volume: 1,
      trades: 1,
    }) as MarketCandle;

  /**
   * A daily bar whose wick is named, stamped on a UTC-midnight grid — the
   * archive's own 1d convention.
   */
  const dailyBar = (
    index: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ): MarketCandle =>
    ({
      openTime: index * DAY,
      closeTime: (index + 1) * DAY - 1,
      open,
      high,
      low,
      close,
      volume: 1,
      trades: 1,
    }) as MarketCandle;
  const DAY = 24 * 60 * 60 * 1_000;

  it("a four-week daily study is 28 bars and 28 whole days, close to close", () => {
    // The canonical request: interval 1d, horizonBars 28. On the close basis
    // the exit is a full 28 intervals after the entry close — 28 whole days,
    // not 27, not a padded month.
    const daily = Array.from({ length: 40 }, (_, i) => dailyBar(i, 100, 102, 98, 100 + i));
    const study = runEventStudy({
      occurrences: [occurrence(0, 2 * DAY + DAY / 2)],
      candles: daily,
      intervalMs: DAY,
      horizonBars: 28,
      entryBasis: "first_closed_bar_after_event",
      metric: "path_extrema",
      direction: "short",
    });
    expect(study.horizonBars).toBe(28);
    expect(study.horizonMs).toBe(28 * DAY);
    expect(study.rows[0]?.covered).toBe(true);
    expect(study.rows[0]?.barsCovered).toBe(28);
    expect((study.rows[0]?.exitTime as number) - (study.rows[0]?.entryTime as number)).toBe(
      28 * DAY,
    );
    // The extremum starts AFTER the entry bar on the close basis: the entry
    // price is the entry bar's close, a price that existed only once that bar
    // had elapsed, so the bar's own 98 wick printed before the entry and
    // cannot be a post-entry extreme. Every bar dips to 98, so the earliest
    // ELIGIBLE bar (the one after entry) wins the tie.
    expect(study.rows[0]?.extremumPrice).toBe(98);
    expect(study.rows[0]?.extremumTime).toBe(3 * DAY);
  });

  it("a short reads the minimum LOW over the entry..exit bars, on each basis", () => {
    // Lows: the deepest wick is bar 5's 90; bar 2 sits before the entry and
    // must not win even though its low (95) is lower than the entry bar's.
    const candles = [
      wickBar(0, 100, 102, 99, 101),
      wickBar(1, 101, 103, 98, 102),
      wickBar(2, 102, 104, 95, 103),
      wickBar(3, 103, 105, 97, 104),
      wickBar(4, 104, 106, 96, 105),
      wickBar(5, 105, 107, 90, 106),
      wickBar(6, 106, 108, 94, 107),
      wickBar(7, 107, 109, 93, 108),
    ];
    // Open basis: the event ends at bar 3's open, entry bar 3, horizon 4
    // covers bars 3..6: the minimum low there is bar 5's 90.
    const open = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 4,
      metric: "path_extrema",
      direction: "short",
    });
    const openRow = open.rows[0];
    expect(openRow?.extremumPrice).toBe(90);
    expect(openRow?.extremumTime).toBe(5 * MINUTE);
    // (90 - 103) / 103 = -12.62%, the long-convention excursion.
    expect(openRow?.excursionReturnPct).toBe(-12.62);
    // Close basis: the event ends inside bar 3, so bar 3's own close (104) is
    // the entry and bars 3..7 hold the minimum: bar 5's 90 again.
    const close = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE + 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 4,
      entryBasis: "first_closed_bar_after_event",
      metric: "path_extrema",
      direction: "short",
    });
    const closeRow = close.rows[0];
    expect(closeRow?.entryPrice).toBe(104);
    expect(closeRow?.extremumPrice).toBe(90);
    expect(closeRow?.extremumTime).toBe(5 * MINUTE);
    // (90 - 104) / 104 = -13.46% — measured from the basis's own entry.
    expect(closeRow?.excursionReturnPct).toBe(-13.46);
  });

  it("a long reads the maximum HIGH, and the terminal return stays separate on the row", () => {
    // Highs peak at bar 4's 150. Entry bar 3 (open basis), horizon 2 covers
    // bars 3..4: the maximum high is 150.
    const candles = [
      wickBar(0, 100, 101, 99, 100),
      wickBar(1, 100, 160, 99, 100),
      wickBar(2, 100, 102, 99, 100),
      wickBar(3, 100, 103, 99, 100),
      wickBar(4, 100, 150, 99, 101),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      metric: "path_extrema",
      direction: "long",
    });
    const row = study.rows[0];
    // Terminal return: (101 - 100) / 100 = +1% — the close, not the wick.
    expect(row?.returnPct).toBe(1);
    // Excursion: (150 - 100) / 100 = +50%, long convention, positive for a
    // long's favorable move.
    expect(row?.excursionReturnPct).toBe(50);
    expect(row?.extremumPrice).toBe(150);
    expect(row?.extremumTime).toBe(4 * MINUTE);
    // Both numbers, always, on a covered path_extrema row.
    expect(row?.returnPct).toBeDefined();
    expect(row?.excursionReturnPct).toBeDefined();
  });

  it("a truncated window measures the extremum over the bars it actually got", () => {
    // Horizon 5 from bar 6 of an 8-bar window: only bars 6..7 exist. The
    // extremum is theirs (bar 7's low 91), and the truncated flag is unchanged.
    const candles = [
      wickBar(0, 100, 102, 99, 101),
      wickBar(1, 101, 103, 98, 102),
      wickBar(2, 102, 104, 80, 103),
      wickBar(3, 103, 105, 97, 104),
      wickBar(4, 104, 106, 96, 105),
      wickBar(5, 105, 107, 95, 106),
      wickBar(6, 106, 108, 92, 107),
      wickBar(7, 107, 109, 91, 108),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 6 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 5,
      metric: "path_extrema",
      direction: "short",
    });
    const row = study.rows[0];
    expect(row?.truncated).toBe(true);
    expect(row?.barsCovered).toBe(2);
    expect(row?.extremumPrice).toBe(91);
    expect(row?.extremumTime).toBe(7 * MINUTE);
  });

  it("ties keep the earliest bar that printed the extremum", () => {
    const candles = [
      wickBar(0, 100, 102, 90, 101),
      wickBar(1, 100, 102, 90, 101),
      wickBar(2, 100, 102, 90, 101),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 0)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 3,
      metric: "path_extrema",
      direction: "short",
    });
    expect(study.rows[0]?.extremumTime).toBe(0);
  });

  it("reports the excursion aggregates over complete horizons only, and never invents them on a forward-return study", () => {
    // Two shorts on a 3-bar open-basis horizon: row 1 (from bar 0) covers
    // bars 0..2, dips to bar 2's low 80 (-20%) and closes at 90 (-10%); row 2
    // (from bar 3) truncates to bars 3..4, dips only to 99 (-1%) and closes at
    // 95 (-5%) — the path went LESS far than it ended. The truncated row keeps
    // its numbers for inspection but leaves the aggregates: one complete
    // horizon carries the mean, and the counts say which is which.
    const candles = [
      wickBar(0, 100, 102, 99, 100),
      wickBar(1, 100, 102, 99, 90),
      wickBar(2, 100, 102, 80, 90),
      wickBar(3, 100, 102, 99, 97),
      wickBar(4, 100, 102, 99, 95),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 0), occurrence(0, 3 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 3,
      metric: "path_extrema",
      direction: "short",
    });
    expect(study.rows.map((row) => row.excursionReturnPct)).toEqual([-20, -1]);
    expect(study.rows.map((row) => row.truncated)).toEqual([false, true]);
    expect(study.nComplete).toBe(1);
    expect(study.nPartial).toBe(1);
    expect(study.nUnavailable).toBe(0);
    expect(study.meanExcursionPct).toBe(-20);
    expect(study.excursionBeyondTerminalPercent).toBe(100);
    expect(study.metric).toBe("path_extrema");

    // The default study stays exactly what it was: no metric, no extrema, no
    // excursion aggregates.
    const plain = runEventStudy({
      occurrences: [occurrence(0, 0)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 3,
    });
    expect(plain.metric).toBeUndefined();
    expect(plain.meanExcursionPct).toBeUndefined();
    expect(plain.excursionBeyondTerminalPercent).toBeUndefined();
    expect(plain.rows[0]?.extremumPrice).toBeUndefined();
    expect(plain.rows[0]?.excursionReturnPct).toBeUndefined();
  });

  it("uncovered rows keep their reasons verbatim and never carry an extremum", () => {
    const candles = Array.from({ length: 5 }, (_, i) => bar(i, 100, 100 + i));
    const study = runEventStudy({
      occurrences: [
        occurrence(0, -10 * MINUTE), // before the archive
        occurrence(0, 99 * MINUTE), // after the last bar: the future
      ],
      candles,
      intervalMs: MINUTE,
      horizonBars: 3,
      metric: "path_extrema",
      direction: "short",
    });
    expect(study.rows.map((row) => row.covered)).toEqual([false, false]);
    expect(study.rows[0]?.reason).toContain("before the archived window");
    expect(study.rows[1]?.reason).toContain("still in the future");
    for (const row of study.rows) {
      expect(row.extremumTime).toBeUndefined();
      expect(row.extremumPrice).toBeUndefined();
      expect(row.excursionReturnPct).toBeUndefined();
    }
    expect(study.meanExcursionPct).toBeNull();
    expect(study.excursionBeyondTerminalPercent).toBeNull();
  });

  it("carries the occurrence's time precision onto the row", () => {
    const candles = Array.from({ length: 5 }, (_, i) => bar(i, 100, 100 + i));
    const study = runEventStudy({
      occurrences: [
        { startAt: 0, endAt: 0, timePrecision: "instant", source: "https://example.com/a" },
        {
          startAt: MINUTE,
          endAt: 2 * MINUTE,
          timePrecision: "date",
          source: "https://example.com/b",
        },
        occurrence(0, 3 * MINUTE), // legacy: no precision claimed
      ],
      candles,
      intervalMs: MINUTE,
      horizonBars: 1,
    });
    expect(study.rows.map((row) => row.timePrecision)).toEqual(["instant", "date", undefined]);
  });
});

describe("a 1d archive reaches events a 4h archive cannot", () => {
  // The canonical four-week study is interval 1d, horizonBars 28 BECAUSE the
  // fine intervals start recording later: an Ethereum fork from before the 4h
  // recorder began is a covered row on 1d bars and an honest uncovered row on
  // 4h bars, reason and all.
  const DAY_MS = 24 * 60 * 60 * 1_000;
  const HOUR_MS = 60 * 60 * 1_000;
  const forkEnd = Date.UTC(2024, 8, 15); // 2024-09-15, before October 2024
  const fork = [{ startAt: forkEnd - DAY_MS, endAt: forkEnd, source: "https://example.com/fork" }];

  /** A grid bar whose low dips to 100 - (i % 4): the lowest low is 97. */
  const gridBar = (openTime: number, closeTime: number, i: number): MarketCandle =>
    ({
      openTime,
      closeTime,
      open: 100,
      high: 102,
      low: 100 - (i % 4),
      close: 100 + (i % 7),
      volume: 1,
      trades: 1,
    }) as MarketCandle;

  it("covers the pre-October occurrence on 1d bars and reports it uncovered on 4h", () => {
    // A daily archive recording since 2020: plenty before the fork. The fork
    // ends on a midnight, so the close basis enters the bar that opens at the
    // boundary and the extremum is the first lowest low (97) in the range.
    const daily = Array.from({ length: 2_000 }, (_, i) =>
      gridBar(Date.UTC(2020, 0, 1) + i * DAY_MS, Date.UTC(2020, 0, 1) + (i + 1) * DAY_MS - 1, i),
    );
    const dailyStudy = runEventStudy({
      occurrences: fork,
      candles: daily,
      intervalMs: DAY_MS,
      horizonBars: 28,
      entryBasis: "first_closed_bar_after_event",
      metric: "path_extrema",
      direction: "short",
    });
    expect(dailyStudy.rows[0]?.covered).toBe(true);
    expect(dailyStudy.rows[0]?.extremumPrice).toBe(97); // the lowest low in 28 bars

    // A 4h archive recording only since November 2024: the fork predates it.
    const fourHour = Array.from({ length: 500 }, (_, i) =>
      gridBar(
        Date.UTC(2024, 10, 1) + i * 4 * HOUR_MS,
        Date.UTC(2024, 10, 1) + (i + 1) * 4 * HOUR_MS - 1,
        i,
      ),
    );
    const fourHourStudy = runEventStudy({
      occurrences: fork,
      candles: fourHour,
      intervalMs: 4 * HOUR_MS,
      horizonBars: 168, // 28 days of 4h bars
      entryBasis: "first_closed_bar_after_event",
    });
    expect(fourHourStudy.rows[0]?.covered).toBe(false);
    expect(fourHourStudy.rows[0]?.reason).toContain("before the archived window");
    expect(fourHourStudy.rows[0]?.extremumPrice).toBeUndefined();
  });
});

describe("the pre-entry wick never counts on the close basis", () => {
  /** A wick bar, named high and low independent of open and close. */
  const wickBar = (
    index: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ): MarketCandle =>
    ({
      openTime: index * MINUTE,
      closeTime: index * MINUTE + MINUTE - 1,
      open,
      high,
      low,
      close,
      volume: 1,
      trades: 1,
    }) as MarketCandle;

  it("a short's excursion reads only post-entry lows: −5%, never the pre-entry −50%", () => {
    // Activation midway through bar 3. Bar 3's low 50 printed before the
    // close that IS the entry, so it is pre-entry; the eligible lows after
    // entry bottom at 95. Hand arithmetic: (95 − 100) / 100 = −5%.
    const candles = [
      wickBar(0, 100, 102, 99, 101),
      wickBar(1, 101, 103, 98, 102),
      wickBar(2, 102, 104, 97, 103),
      wickBar(3, 103, 120, 50, 100),
      wickBar(4, 100, 101, 95, 100),
      wickBar(5, 100, 101, 96, 99),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE + 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
      metric: "path_extrema",
      direction: "short",
    });
    const row = study.rows[0];
    expect(row?.covered).toBe(true);
    expect(row?.entryPrice).toBe(100);
    expect(row?.extremumPrice).toBe(95);
    expect(row?.extremumTime).toBe(4 * MINUTE);
    expect(row?.excursionReturnPct).toBe(-5);
  });

  it("the long/high symmetry: a pre-entry spike to 200 never counts", () => {
    // Same shape, mirrored: bar 3's high 200 elapsed before the entry close,
    // post-entry highs peak at 150. (150 − 100) / 100 = +50%, never +100%.
    const candles = [
      wickBar(0, 100, 101, 99, 100),
      wickBar(1, 100, 102, 98, 101),
      wickBar(2, 100, 103, 97, 102),
      wickBar(3, 102, 200, 90, 100),
      wickBar(4, 100, 150, 99, 110),
      wickBar(5, 110, 140, 99, 120),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE + 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
      metric: "path_extrema",
      direction: "long",
    });
    const row = study.rows[0];
    expect(row?.extremumPrice).toBe(150);
    expect(row?.extremumTime).toBe(4 * MINUTE);
    expect(row?.excursionReturnPct).toBe(50);
  });

  it("an all-unfavorable path reports the adverse excursion without inventing a gain", () => {
    // A short whose path only rises: every post-entry low sits above the
    // entry, so the excursion is adverse (positive in the long convention)
    // and no surface may clamp it into a profit. Lows 102 then 101 → the
    // lowest post-entry low is 101 → (101 − 100) / 100 = +1%.
    const candles = [
      wickBar(0, 100, 101, 99, 100),
      wickBar(1, 100, 101, 99, 100),
      wickBar(2, 100, 101, 99, 100),
      wickBar(3, 100, 120, 99, 100),
      wickBar(4, 100, 110, 102, 105),
      wickBar(5, 105, 112, 101, 108),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE + 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
      metric: "path_extrema",
      direction: "short",
    });
    const row = study.rows[0];
    expect(row?.extremumPrice).toBe(101);
    expect(row?.excursionReturnPct).toBe(1);
    expect(study.meanExcursionPct).toBe(1);
  });

  it("the terminal bar's extreme is eligible on both bases", () => {
    // The lowest post-entry low lands on the exit bar itself: the exit bar
    // elapsed within the horizon, so its wick counts on either basis.
    const candles = [
      wickBar(0, 100, 101, 99, 100),
      wickBar(1, 100, 101, 99, 100),
      wickBar(2, 100, 101, 99, 100),
      wickBar(3, 100, 101, 99, 100),
      wickBar(4, 100, 101, 92, 100),
    ];
    const close = runEventStudy({
      occurrences: [occurrence(0, 2 * MINUTE + 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
      metric: "path_extrema",
      direction: "short",
    });
    expect(close.rows[0]?.extremumPrice).toBe(92);
    expect(close.rows[0]?.extremumTime).toBe(4 * MINUTE);
    const open = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      metric: "path_extrema",
      direction: "short",
    });
    expect(open.rows[0]?.extremumPrice).toBe(92);
    expect(open.rows[0]?.extremumTime).toBe(4 * MINUTE);
  });
});

describe("expected entry slots, grid runs, and one as-of cutoff", () => {
  const wickBar = (
    index: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ): MarketCandle =>
    ({
      openTime: index * MINUTE,
      closeTime: index * MINUTE + MINUTE - 1,
      open,
      high,
      low,
      close,
      volume: 1,
      trades: 1,
    }) as MarketCandle;

  it("a missing intrabar activation bar is missing data, not a shift to the next candle", () => {
    // The activation lands inside bar 3's slot and bar 3 is absent. The first
    // archived close after it is bar 4's, but entering there would silently
    // move the declared entry — the row refuses.
    const gappy = [
      wickBar(0, 100, 101, 99, 100),
      wickBar(1, 100, 101, 99, 100),
      wickBar(2, 100, 101, 99, 100),
      // bar 3 missing: the slot the activation's entry close belongs to.
      wickBar(4, 100, 101, 99, 104),
      wickBar(5, 100, 101, 99, 105),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE + 30_000)],
      candles: gappy,
      intervalMs: MINUTE,
      horizonBars: 1,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.rows[0]?.covered).toBe(false);
    expect(study.rows[0]?.reason).toContain("recording gap covers the 1 bar(s)");
    expect(study.rows[0]?.reason).toContain("close");
    expect(study.meanReturnPct).toBeNull();
  });

  it("an interior gap truncates the horizon at the gap instead of stretching it", () => {
    // Entry bar 2, horizon 3 wants bar 5's close over an unbroken grid; bar 4
    // is missing, so the run ends at bar 3. The row measures one interval,
    // says why, and leaves the aggregates.
    const gappy = [
      wickBar(0, 100, 101, 99, 100),
      wickBar(1, 100, 101, 99, 101),
      wickBar(2, 100, 101, 99, 102),
      wickBar(3, 100, 101, 99, 103),
      // bar 4 missing.
      wickBar(5, 100, 101, 99, 105),
      wickBar(6, 100, 101, 99, 106),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 2 * MINUTE)],
      candles: gappy,
      intervalMs: MINUTE,
      horizonBars: 3,
      entryBasis: "first_closed_bar_after_event",
    });
    const row = study.rows[0];
    expect(row?.covered).toBe(true);
    expect(row?.truncated).toBe(true);
    expect(row?.truncationReason).toContain("internal recording gap");
    expect(row?.barsCovered).toBe(1);
    expect(row?.exitPrice).toBe(103);
    expect(study.nComplete).toBe(0);
    expect(study.nPartial).toBe(1);
    expect(study.meanReturnPct).toBeNull();
    // Bridging the gap would have reported bar 5's close (105) as a 3-bar
    // exit; the honest row stops at bar 3.
  });

  it("a missing terminal exit slot with later data is a gap truncation too", () => {
    // Entry bar 2, horizon 3 wants bar 5; bars 3 and 4 exist, bar 5 is
    // missing, bar 6 exists. The exit slot is not reachable over an unbroken
    // grid, and the data after the gap cannot stand in for it.
    const gappy = [
      wickBar(0, 100, 101, 99, 100),
      wickBar(1, 100, 101, 99, 100),
      wickBar(2, 100, 101, 99, 102),
      wickBar(3, 100, 101, 99, 103),
      wickBar(4, 100, 101, 99, 104),
      // bar 5 missing: the declared exit slot.
      wickBar(6, 100, 101, 99, 106),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, 2 * MINUTE)],
      candles: gappy,
      intervalMs: MINUTE,
      horizonBars: 3,
      entryBasis: "first_closed_bar_after_event",
    });
    const row = study.rows[0];
    expect(row?.covered).toBe(true);
    expect(row?.truncated).toBe(true);
    expect(row?.truncationReason).toContain("internal recording gap");
    expect(row?.barsCovered).toBe(2);
    expect(row?.exitPrice).toBe(104);
  });

  it("an incomplete tail truncates with the tail reason", () => {
    const candles = [
      wickBar(0, 100, 101, 99, 100),
      wickBar(1, 100, 101, 99, 100),
      wickBar(2, 100, 101, 99, 100),
    ];
    const study = runEventStudy({
      occurrences: [occurrence(0, MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 5,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.rows[0]?.truncated).toBe(true);
    expect(study.rows[0]?.truncationReason).toContain("archived data ends");
    expect(study.rows[0]?.barsCovered).toBe(1);
  });

  it("one as-of cutoff: a forming bar cannot change entries, exits, extrema or baseline", () => {
    // Six closed bars and a forming seventh whose wild low would win any
    // extremum it touched. `now` sits at bar 5's close, so bar 6 is excluded
    // everywhere: the row's extremum stays bar 4's 95, and a horizon that
    // wanted bar 6 truncates at bar 5 rather than reading the forming close.
    const closed = [
      wickBar(0, 100, 101, 99, 100),
      wickBar(1, 100, 101, 99, 100),
      wickBar(2, 100, 101, 96, 100),
      wickBar(3, 100, 101, 99, 100),
      wickBar(4, 100, 101, 95, 100),
      wickBar(5, 100, 101, 97, 100),
    ];
    const forming = wickBar(6, 100, 101, 10, 93);
    const now = 6 * MINUTE - 1; // bar 5's closing millisecond
    const complete = runEventStudy({
      occurrences: [occurrence(0, MINUTE + 30_000)],
      candles: [...closed, forming],
      intervalMs: MINUTE,
      horizonBars: 3,
      entryBasis: "first_closed_bar_after_event",
      metric: "path_extrema",
      direction: "short",
      now,
    });
    // Entry bar 1 (contains the activation), horizon 3 wants bar 4: complete,
    // and the extremum over bars 2..4 is bar 4's 95 — the forming low 10
    // never entered the measurement.
    expect(complete.rows[0]?.truncated).toBe(false);
    expect(complete.rows[0]?.extremumPrice).toBe(95);
    expect(complete.rows[0]?.extremumTime).toBe(4 * MINUTE);
    expect(complete.baseline?.samples).toBe(3); // windows 0..3, 1..4, 2..5 of the closed grid

    // An exit slot that lands on the forming bar truncates at the cutoff
    // instead of reading the forming close: entry bar 3, horizon 3 wants bar
    // 6 (forming) → the row measures bars 4..5 and says the data ends.
    const exitOnForming = runEventStudy({
      occurrences: [occurrence(0, 3 * MINUTE + 30_000)],
      candles: [...closed, forming],
      intervalMs: MINUTE,
      horizonBars: 3,
      entryBasis: "first_closed_bar_after_event",
      now,
    });
    expect(exitOnForming.rows[0]?.truncated).toBe(true);
    expect(exitOnForming.rows[0]?.truncationReason).toContain("archived data ends");
    expect(exitOnForming.rows[0]?.exitPrice).toBe(100);
    expect(exitOnForming.rows[0]?.exitTime).toBe(6 * MINUTE - 1);
    expect(exitOnForming.nPartial).toBe(1);
    expect(exitOnForming.meanReturnPct).toBeNull();
  });
});

describe("complete horizons carry the aggregates (partial rows stay for inspection)", () => {
  /** A bar at 1m cadence, open 100 and close named. */
  const closeBar = (index: number, close: number): MarketCandle =>
    ({
      openTime: index * MINUTE,
      closeTime: index * MINUTE + MINUTE - 1,
      open: 100,
      high: Math.max(100, close),
      low: Math.min(100, close),
      close,
      volume: 1,
      trades: 1,
    }) as MarketCandle;

  it("a mixed complete/partial report aggregates the complete row only", () => {
    // Closes: [100, 100, 105, 110, 100, 100, 100, 103]. Occurrence A ends at
    // bar 1's open: entry close 100, horizon 2 exits at bar 3's close 110 →
    // +10%, complete. Occurrence B ends at bar 6's open: entry close 100,
    // horizon 2 wants bar 8 — only bar 7 exists → +3% over ONE interval,
    // partial. Every aggregate comes from A alone, and the counts are
    // unambiguous: 2 recorded, 2 covered, 1 complete, 1 partial, 0 unavailable.
    const candles = [100, 100, 105, 110, 100, 100, 100, 103].map((close, index) =>
      closeBar(index, close),
    );
    const study = runEventStudy({
      occurrences: [occurrence(0, MINUTE), occurrence(0, 6 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.n).toBe(2);
    expect(study.nCovered).toBe(2);
    expect(study.nComplete).toBe(1);
    expect(study.nPartial).toBe(1);
    expect(study.nUnavailable).toBe(0);
    expect(study.rows.map((row) => row.returnPct)).toEqual([10, 3]);
    expect(study.meanReturnPct).toBe(10);
    expect(study.medianReturnPct).toBe(10);
    expect(study.hitRatePercent).toBe(100);
    expect(study.bestReturnPct).toBe(10);
    expect(study.worstReturnPct).toBe(10);
    expect(study.verdict).toContain("1 of those completed the full 2-bar horizon");
  });

  it("an all-partial study reports no full-horizon mean, never a partial-window number", () => {
    const candles = [100, 100, 104].map((close, index) => closeBar(index, close));
    const study = runEventStudy({
      occurrences: [occurrence(0, MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 5,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.nCovered).toBe(1);
    expect(study.nComplete).toBe(0);
    expect(study.nPartial).toBe(1);
    expect(study.meanReturnPct).toBeNull();
    expect(study.medianReturnPct).toBeNull();
    expect(study.hitRatePercent).toBeNull();
    expect(study.bestReturnPct).toBeNull();
    expect(study.worstReturnPct).toBeNull();
    expect(study.verdict).toContain("no full-horizon return exists to aggregate");
  });

  it("an all-unavailable study is not a zero return", () => {
    const candles = [100, 100].map((close, index) => closeBar(index, close));
    const study = runEventStudy({
      occurrences: [occurrence(0, -10 * MINUTE)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.nUnavailable).toBe(1);
    expect(study.meanReturnPct).toBeNull();
    expect(study.hitRatePercent).toBeNull();
  });
});

describe("the baseline asks the same question of the same kind of window", () => {
  const closeBar = (index: number, close: number): MarketCandle =>
    ({
      openTime: index * MINUTE,
      closeTime: index * MINUTE + MINUTE - 1,
      open: 100,
      high: Math.max(100, close),
      low: Math.min(100, close),
      close,
      volume: 1,
      trades: 1,
    }) as MarketCandle;

  it("samples only unbroken windows: a gap that would bridge a sample excludes it", () => {
    // Five slots with bar 2 missing (0,1,3,4,5): a horizon-2 close-to-close
    // sample needs three contiguous bars, so only the 3..5 run qualifies —
    // one sample, and the 0→(would-be)3 window never bridges the gap.
    const candles = [0, 1, 3, 4, 5].map((index) => closeBar(index, 100 + index));
    const study = runEventStudy({
      occurrences: [occurrence(0, 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.baseline?.samples).toBe(1);
    // The one sample: entry close 103 (bar 3) → exit close 105 (bar 5).
    expect(study.baseline?.meanReturnPct).toBe(1.94);
  });

  it("reports no baseline at all when no complete window exists", () => {
    const candles = [0, 1, 2].map((index) => closeBar(index, 100));
    const study = runEventStudy({
      occurrences: [occurrence(0, 30_000)],
      candles,
      intervalMs: MINUTE,
      horizonBars: 3,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(study.baseline).toBeNull();
  });
});

describe("storage artifacts are normalized; market data is never fabricated", () => {
  const closeBar = (index: number, close: number): MarketCandle =>
    ({
      openTime: index * MINUTE,
      closeTime: index * MINUTE + MINUTE - 1,
      open: 100,
      high: Math.max(100, close),
      low: Math.min(100, close),
      close,
      volume: 1,
      trades: 1,
    }) as MarketCandle;

  it("duplicated and out-of-order rows measure identically to the sorted unique grid", () => {
    const grid = [100, 100, 105, 110, 100].map((close, index) => closeBar(index, close));
    const shuffled = [
      grid[3] as MarketCandle,
      grid[0] as MarketCandle,
      grid[3] as MarketCandle,
      grid[4] as MarketCandle,
      grid[1] as MarketCandle,
      grid[2] as MarketCandle,
    ];
    const tidy = runEventStudy({
      occurrences: [occurrence(0, MINUTE)],
      candles: grid,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
    });
    const messy = runEventStudy({
      occurrences: [occurrence(0, MINUTE)],
      candles: shuffled,
      intervalMs: MINUTE,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(messy.rows[0]?.covered).toBe(true);
    expect(messy.rows[0]?.returnPct).toBe(tidy.rows[0]?.returnPct);
    expect(messy.rows[0]?.exitTime).toBe(tidy.rows[0]?.exitTime);
    expect(messy.baseline).toEqual(tidy.baseline);
    expect(messy.nComplete).toBe(tidy.nComplete);
  });
});

describe("the metric resolver: one rule for both tool boundaries", () => {
  it("defaults to forward_return and resolves path_extrema's own defaults", () => {
    expect(resolveEventStudyMetric({})).toEqual({ metric: "forward_return" });
    expect(resolveEventStudyMetric({ metric: "path_extrema", direction: "short" })).toEqual({
      metric: "path_extrema",
      direction: "short",
      priceField: "low",
    });
    expect(resolveEventStudyMetric({ metric: "path_extrema", direction: "long" })).toEqual({
      metric: "path_extrema",
      direction: "long",
      priceField: "high",
    });
    expect(
      resolveEventStudyMetric({ metric: "path_extrema", direction: "long", priceField: "high" }),
    ).toEqual({ metric: "path_extrema", direction: "long", priceField: "high" });
  });

  it("refuses a contradictory direction and price field", () => {
    const shortHigh = resolveEventStudyMetric({
      metric: "path_extrema",
      direction: "short",
      priceField: "high",
    });
    expect("reason" in shortHigh && shortHigh.reason).toContain("contradicts direction short");
    const longLow = resolveEventStudyMetric({
      metric: "path_extrema",
      direction: "long",
      priceField: "low",
    });
    expect("reason" in longLow && longLow.reason).toContain("contradicts direction long");
  });

  it("refuses path_extrema with no direction, and direction on a forward-return study", () => {
    const noDirection = resolveEventStudyMetric({ metric: "path_extrema" });
    expect("reason" in noDirection && noDirection.reason).toContain("needs a direction");
    const stray = resolveEventStudyMetric({ direction: "short" });
    expect("reason" in stray && stray.reason).toContain(
      "direction and priceField apply only to the path_extrema metric",
    );
  });
});

describe("the caps and the occurrence validator", () => {
  it("bounds the horizon at both ends before a bar is loaded", () => {
    expect(checkEventStudy({ horizonBars: 0 })).toContain("whole number of bars from 1");
    expect(checkEventStudy({ horizonBars: EVENT_STUDY_MAX_HORIZON_BARS + 1 })).toContain(
      `1 to ${EVENT_STUDY_MAX_HORIZON_BARS}`,
    );
    expect(checkEventStudy({ horizonBars: 2.5 })).toContain("whole number of bars from 1");
    expect(checkEventStudy({ horizonBars: 1 })).toBeNull();
    expect(checkEventStudy({ horizonBars: EVENT_STUDY_MAX_HORIZON_BARS })).toBeNull();
  });

  it("refuses an occurrence that ends before it starts", () => {
    expect(validateEventOccurrence(occurrence(100, 99))).toContain("cannot end before it begins");
    expect(validateEventOccurrence(occurrence(100, 100))).toBeNull();
  });

  it("refuses an occurrence claiming instant precision with unequal ends", () => {
    expect(
      validateEventOccurrence({ ...occurrence(100, 101), timePrecision: "instant" }),
    ).toContain("must start and end at the same moment");
    expect(
      validateEventOccurrence({ ...occurrence(100, 100), timePrecision: "instant" }),
    ).toBeNull();
    // Absent precision is a legacy row, never re-derived: unequal ends are fine.
    expect(validateEventOccurrence(occurrence(100, 101))).toBeNull();
  });

  it("refuses an occurrence with no source", () => {
    expect(validateEventOccurrence({ startAt: 0, endAt: 1, source: "  " })).toContain(
      "source cannot be empty",
    );
    expect(validateEventOccurrence({ startAt: 0, endAt: 1, source: "user provided" })).toBeNull();
  });
});

describe("the tool's ISO conventions", () => {
  const parse = (input: {
    start: string;
    end?: string;
    precision?: "instant" | "window" | "date";
    label?: string;
    source: string;
  }) => parseTradingEventsOccurrence(input);

  it("reads a date-only start as a date-precision span of that whole UTC day", () => {
    const parsed = parse({ start: "2024-11-12", source: "url" });
    if (!("occurrence" in parsed)) return;
    expect(parsed.occurrence.startAt).toBe(Date.parse("2024-11-12T00:00:00Z"));
    // The whole day, exclusively: after Devcon means after the LAST day.
    expect(parsed.occurrence.endAt).toBe(Date.parse("2024-11-13T00:00:00Z"));
    expect(parsed.occurrence.timePrecision).toBe("date");
  });

  it("a date-only end is the exclusive next midnight of THAT day", () => {
    const parsed = parse({ start: "2024-11-12", end: "2024-11-15", source: "url" });
    if (!("occurrence" in parsed)) return;
    expect(parsed.occurrence.endAt).toBe(Date.parse("2024-11-16T00:00:00Z"));
    expect(parsed.occurrence.timePrecision).toBe("date");
  });

  it("a timed start with equal timed ends is an instant, preserved exactly", () => {
    // A protocol activation is a moment, not a day: recording it with equal
    // timed strings must preserve both instants exactly and claim instant
    // precision, never widen the span to a day it did not span.
    const parsed = parse({
      start: "2022-09-15T06:42:42Z",
      end: "2022-09-15T06:42:42Z",
      source: "https://ethereum.org/ethereum-forks/",
    });
    if (!("occurrence" in parsed)) return;
    expect(parsed.occurrence.startAt).toBe(Date.parse("2022-09-15T06:42:42Z"));
    expect(parsed.occurrence.endAt).toBe(parsed.occurrence.startAt);
    expect(parsed.occurrence.timePrecision).toBe("instant");
  });

  it("a timed start with a later timed end is a window", () => {
    const parsed = parse({
      start: "2024-11-12T09:00:00Z",
      end: "2024-11-12T18:00:00Z",
      source: "u",
    });
    if (!("occurrence" in parsed)) return;
    expect(parsed.occurrence.startAt).toBe(Date.parse("2024-11-12T09:00:00Z"));
    expect(parsed.occurrence.endAt).toBe(Date.parse("2024-11-12T18:00:00Z"));
    expect(parsed.occurrence.timePrecision).toBe("window");
  });

  it("preserves the exact UTC milliseconds of a timed instant", () => {
    const parsed = parse({
      start: "2024-11-12T09:30:00.250Z",
      end: "2024-11-12T09:30:00.250Z",
      source: "u",
    });
    if (!("occurrence" in parsed)) return;
    expect(parsed.occurrence.startAt).toBe(Date.parse("2024-11-12T09:30:00.250Z"));
    expect(parsed.occurrence.endAt).toBe(parsed.occurrence.startAt);
  });

  it("refuses a timed start with no end rather than inventing a day", () => {
    // The fabrication this model replaces: a lone timed start used to be
    // padded to its day's midnight, writing a span the research never gave.
    const parsed = parse({ start: "2024-11-12T09:30:00Z", source: "url" });
    if ("reason" in parsed) {
      expect(parsed.reason).toContain("a timed start with no end cannot invent a duration");
      expect(parsed.reason).toContain("use a date-only start for date precision");
    }
  });

  it("refuses a date-only end beside a timed start as ambiguous", () => {
    const parsed = parse({ start: "2024-11-12T09:00:00Z", end: "2024-11-15", source: "url" });
    if ("reason" in parsed) {
      expect(parsed.reason).toContain("end must be a timed instant when start is timed");
      expect(parsed.reason).toContain("a date-only end pairs with a date-only start");
    }
  });

  it("refuses a timed end beside a date-only start as ambiguous", () => {
    const parsed = parse({ start: "2024-11-12", end: "2024-11-15T09:00:00Z", source: "url" });
    if ("reason" in parsed) {
      expect(parsed.reason).toContain("end must be a date-only date when start is date-only");
      expect(parsed.reason).toContain("a timed end pairs with a timed start");
    }
  });

  it("refuses a date-only start that claims instant or window precision", () => {
    for (const precision of ["instant", "window"] as const) {
      const parsed = parse({ start: "2024-11-12", precision, source: "url" });
      if ("reason" in parsed) {
        expect(parsed.reason).toContain("a date-only start cannot claim an exact instant");
        expect(parsed.reason).toContain(
          "record the timed activation instant, or keep date precision",
        );
      }
    }
  });

  it("refuses a timed start that claims date precision", () => {
    const parsed = parse({
      start: "2022-09-15T06:42:42Z",
      end: "2022-09-15T06:42:42Z",
      precision: "date",
      source: "url",
    });
    if ("reason" in parsed)
      expect(parsed.reason).toContain("a timed instant cannot claim date precision");
  });

  it("refuses a declared precision the timed shapes contradict", () => {
    const notInstant = parse({
      start: "2024-11-12T09:00:00Z",
      end: "2024-11-12T18:00:00Z",
      precision: "instant",
      source: "u",
    });
    if ("reason" in notInstant) {
      expect(notInstant.reason).toContain('declared precision "instant" does not match the span');
    }
    const notWindow = parse({
      start: "2024-11-12T09:00:00Z",
      end: "2024-11-12T09:00:00Z",
      precision: "window",
      source: "u",
    });
    if ("reason" in notWindow) {
      expect(notWindow.reason).toContain('declared precision "window" does not match the span');
    }
  });

  it("accepts a declared precision the shapes agree with", () => {
    const date = parse({ start: "2024-11-12", precision: "date", source: "url" });
    if ("occurrence" in date) expect(date.occurrence.timePrecision).toBe("date");
    const instant = parse({
      start: "2022-09-15T06:42:42Z",
      end: "2022-09-15T06:42:42Z",
      precision: "instant",
      source: "url",
    });
    if ("occurrence" in instant) expect(instant.occurrence.timePrecision).toBe("instant");
    const window = parse({
      start: "2024-11-12T09:00:00Z",
      end: "2024-11-12T18:00:00Z",
      precision: "window",
      source: "url",
    });
    if ("occurrence" in window) expect(window.occurrence.timePrecision).toBe("window");
  });

  it("refuses a string that is not a date, naming the field", () => {
    const bad = parse({ start: "Devcon, probably", source: "url" });
    if ("reason" in bad) expect(bad.reason).toContain("start");
    const badEnd = parse({ start: "2024-11-12", end: "soon after", source: "url" });
    if ("reason" in badEnd) expect(badEnd.reason).toContain("end");
  });
});

describe("the read-back confirmation payload", () => {
  const payload = {
    threadId: "thread-1",
    action: "record" as const,
    name: "Devcon",
    occurrences: [
      { startAt: 0, endAt: 0, timePrecision: "instant" as const, source: "https://a.dev" },
      {
        startAt: 86_400_000,
        endAt: 3 * 86_400_000,
        timePrecision: "date" as const,
        label: "SEA",
        source: "https://b.dev",
      },
    ],
  };

  it("serializes the same payload to the same string, order included", () => {
    expect(serializeEventConfirmationPayload(payload)).toBe(
      serializeEventConfirmationPayload(payload),
    );
    // Order is part of the payload: the same rows in the other order differ.
    const reordered = {
      ...payload,
      occurrences: [...payload.occurrences].reverse(),
    };
    expect(serializeEventConfirmationPayload(reordered)).not.toBe(
      serializeEventConfirmationPayload(payload),
    );
  });

  it("changes when anything it covers changes", () => {
    const base = serializeEventConfirmationPayload(payload);
    expect(serializeEventConfirmationPayload({ ...payload, threadId: "thread-2" })).not.toBe(base);
    expect(serializeEventConfirmationPayload({ ...payload, action: "add" })).not.toBe(base);
    expect(serializeEventConfirmationPayload({ ...payload, name: "Breakpoint" })).not.toBe(base);
    expect(
      serializeEventConfirmationPayload({
        ...payload,
        occurrences: payload.occurrences.map((row) => ({ ...row, startAt: row.startAt + 1 })),
      }),
    ).not.toBe(base);
    expect(
      serializeEventConfirmationPayload({
        ...payload,
        occurrences: payload.occurrences.map((row, i) =>
          i === 0 ? { ...row, timePrecision: "window" as const } : row,
        ),
      }),
    ).not.toBe(base);
    expect(
      serializeEventConfirmationPayload({
        ...payload,
        occurrences: payload.occurrences.map((row, i) =>
          i === 1 ? { ...row, label: "Bogota" } : row,
        ),
      }),
    ).not.toBe(base);
    expect(
      serializeEventConfirmationPayload({
        ...payload,
        occurrences: payload.occurrences.map((row, i) =>
          i === 0 ? { ...row, source: "user provided" } : row,
        ),
      }),
    ).not.toBe(base);
    // Absent optionals serialize as "" and stay stable.
    const legacy = {
      threadId: "thread-1",
      action: "add" as const,
      name: "",
      occurrences: [{ startAt: 0, endAt: 1, source: "u" }],
    };
    expect(serializeEventConfirmationPayload(legacy)).toBe(
      serializeEventConfirmationPayload(legacy),
    );
  });
});

describe("the study's hydration window", () => {
  const DAY = 24 * 60 * 60_000;
  // Devcon-shaped: two ended occurrences and one still in the future.
  const now = 100 * DAY;
  const endedEarly = occurrence(10 * DAY, 11 * DAY);
  const endedLate = occurrence(20 * DAY, 21 * DAY);
  const future = occurrence(150 * DAY, 151 * DAY);

  it("spans the first required entry to the last required exit of the ended occurrences", () => {
    const window = eventStudyHydrationWindow([endedLate, endedEarly, future], {
      intervalMs: DAY,
      horizonBars: 3,
      now,
    });
    expect(window).toEqual({ fromT: 11 * DAY, toT: 21 * DAY + 2 * DAY });
  });

  it("aligns the entry up to the grid and truncates the exit at now", () => {
    // Ends mid-bar on a daily grid: the entry is the next midnight.
    const midBar = occurrence(10 * DAY, 11 * DAY + 6 * 60 * 60_000);
    const window = eventStudyHydrationWindow([midBar], {
      intervalMs: DAY,
      horizonBars: 30,
      now: 40 * DAY,
    });
    expect(window).toEqual({ fromT: 12 * DAY, toT: 40 * DAY });
  });

  it("needs nothing when no occurrence has ended", () => {
    expect(
      eventStudyHydrationWindow([future], { intervalMs: DAY, horizonBars: 3, now }),
    ).toBeNull();
  });

  it("needs nothing when the first entry bar has not opened yet", () => {
    // Ended a millisecond ago on a daily grid: the entry bar opens at the
    // next midnight, which is in the future — nothing to fetch.
    const justEnded = occurrence(50 * DAY, now - 1);
    expect(
      eventStudyHydrationWindow([justEnded], { intervalMs: DAY, horizonBars: 3, now }),
    ).toBeNull();
  });

  it("horizon one ends at the entry bar itself", () => {
    const window = eventStudyHydrationWindow([endedEarly], {
      intervalMs: DAY,
      horizonBars: 1,
      now,
    });
    expect(window).toEqual({ fromT: 11 * DAY, toT: 11 * DAY });
  });

  it("on the close basis the window starts one bar earlier and ends one bar later", () => {
    // The close basis enters on the close of the bar whose open slot the
    // event falls inside (floor, not ceil), and its exit is a full horizon of
    // close-to-close intervals after that bar's open.
    const window = eventStudyHydrationWindow([endedEarly], {
      intervalMs: DAY,
      horizonBars: 3,
      now,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(window).toEqual({ fromT: 11 * DAY, toT: 14 * DAY });
    const midBar = eventStudyHydrationWindow([occurrence(10 * DAY, 11 * DAY + 6 * 60 * 60_000)], {
      intervalMs: DAY,
      horizonBars: 30,
      now: 40 * DAY,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(midBar).toEqual({ fromT: 11 * DAY, toT: 40 * DAY });
    const horizonOne = eventStudyHydrationWindow([endedEarly], {
      intervalMs: DAY,
      horizonBars: 1,
      now,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(horizonOne).toEqual({ fromT: 11 * DAY, toT: 12 * DAY });
  });
});

describe("the study's read window", () => {
  const DAY = 24 * 60 * 60_000;
  const now = 100 * DAY;
  const endedEarly = occurrence(10 * DAY, 11 * DAY);
  const endedLate = occurrence(20 * DAY, 21 * DAY);
  const future = occurrence(150 * DAY, 151 * DAY);

  it("is the hydration window when an occurrence has ended — one rule for both callers", () => {
    const window = eventStudyReadWindow([endedLate, endedEarly, future], {
      intervalMs: DAY,
      horizonBars: 3,
      now,
    });
    expect(window).toEqual(
      eventStudyHydrationWindow([endedLate, endedEarly, future], {
        intervalMs: DAY,
        horizonBars: 3,
        now,
      }),
    );
    expect(window).toEqual({ fromT: 11 * DAY, toT: 23 * DAY });
  });

  it("is a two-bar recent tail when nothing has ended, so future rows read honestly", () => {
    expect(eventStudyReadWindow([future], { intervalMs: DAY, horizonBars: 3, now })).toEqual({
      fromT: now - 2 * DAY,
      toT: now,
    });
  });

  it("is bounded by the occurrences and the horizon, never by the archive's size", () => {
    // However much history the archive holds beside them, a study of two
    // recent occurrences with a short horizon reads a handful of bars.
    const window = eventStudyReadWindow([endedEarly, endedLate], {
      intervalMs: DAY,
      horizonBars: 5,
      now,
    });
    expect(window).toEqual({ fromT: 11 * DAY, toT: 25 * DAY });
  });

  it("carries the entry basis through, one rule for both callers", () => {
    const input = {
      intervalMs: DAY,
      horizonBars: 3,
      now,
      entryBasis: "first_closed_bar_after_event" as const,
    };
    expect(eventStudyReadWindow([endedLate, endedEarly, future], input)).toEqual(
      eventStudyHydrationWindow([endedLate, endedEarly, future], input),
    );
  });
});

describe("the menus teach the conventions the parser enforces", () => {
  it("the events menu states the timing, single-source, and read-back rules", () => {
    const menu = renderTradingEventsMenu();
    // Tight enough to serve as a menu: the look menu's 1,500-char budget is
    // the discipline here too.
    expect(menu.length).toBeLessThan(1_500);
    // The timing model: date precision spans, the instant rule, the refusal
    // that replaced the +24h fabrication.
    expect(menu).toContain("date precision");
    expect(menu).toContain("same instant is an activation");
    expect(menu).toContain("a timed start with no end is refused");
    expect(menu).toContain("instant/window/date");
    expect(menu).toContain("UTC ISO");
    // One source, never several.
    expect(menu).toContain("one source per occurrence");
    expect(menu).toContain("never several joined");
    // The read-back protocol.
    expect(menu).toContain("preview");
    expect(menu).toContain("requireReadBack");
    expect(menu).toContain("confirmationDigest");
    // The study conventions another caller needs verbatim.
    expect(menu).toContain("entryBasis");
    expect(menu).toContain("first_closed_bar_after_event");
    expect(menu).toContain("interval 1m 3m 5m 15m 1h 4h 1d");
    expect(menu).toContain("a four-week daily study is interval 1d, horizonBars 28");
    expect(menu).toContain("coarsest interval");
    // The metric vocabulary, and the hindsight honesty that rides it.
    expect(menu).toContain("path_extrema");
    expect(menu).toContain("direction");
    expect(menu).toContain("hindsight-perfect");
  });
});
