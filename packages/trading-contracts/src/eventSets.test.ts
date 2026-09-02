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
  });
});
