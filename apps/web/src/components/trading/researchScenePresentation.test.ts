import { describe, expect, it } from "vite-plus/test";

import {
  OCCURRENCE_CONTEXT_BARS,
  activeGraphScenes,
  aggregateAlignedTrace,
  alignedTracePoints,
  askAboutOccurrenceSentence,
  BASELINE_REFERENCE_LABEL,
  BASELINE_UNAVAILABLE_SENTENCE,
  baselineReference,
  describeHorizon,
  fmtUsd,
  grossChangeUsd,
  historicalGrossChangeLabel,
  nextGraphViewMode,
  DERIVED_VS_AUTHORED_SENTENCE,
  liveResearchMarkers,
  MARKER_LEGEND_SENTENCE,
  occurrenceStudyOverlay,
  payloadEntryBasis,
  provenanceTrailLine,
  occurrenceWindow,
  researchMarkerAccessibleName,
  sceneAutoFitDecision,
  sceneAutoFitRecommendation,
  studyExplanationLines,
  studyRuleSentence,
  studyWindowMaxBars,
  STUDY_RULE_SENTENCE,
  turnIntoStrategySentence,
  uncoveredOccurrenceNotes,
  validateForwardSentence,
} from "./researchScenePresentation.ts";
import { EVENT_STUDY_MAX_HORIZON_BARS } from "@t3tools/trading-contracts/eventSets";
import {
  RESEARCH_DISCLAIMER,
  STUDY_CHART_MAX_WINDOW_BARS,
} from "@t3tools/trading-contracts/researchScenes";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = 1_800_000_000_000;

const candle = (openTime: number, open: number, close: number) => ({ openTime, open, close });

describe("alignedTracePoints", () => {
  const candles = [
    candle(NOW, 100, 99),
    candle(NOW + DAY, 100, 105),
    candle(NOW + 2 * DAY, 100, 110),
    candle(NOW + 3 * DAY, 100, 104),
  ];

  it("rebases closes to the first bar at or after the entry, capped at the horizon", () => {
    const trace = alignedTracePoints({
      candles,
      entryTime: NOW + DAY,
      intervalMs: DAY,
      horizonBars: 2,
    });
    expect(trace).toEqual([
      { barsSinceEntry: 0, changePct: 5 },
      { barsSinceEntry: 1, changePct: 10 },
    ]);
  });

  it("is empty when no bar lands at or after the entry: no fabricated line", () => {
    expect(
      alignedTracePoints({ candles, entryTime: NOW + 30 * DAY, intervalMs: DAY, horizonBars: 5 }),
    ).toEqual([]);
    expect(
      alignedTracePoints({ candles: [], entryTime: NOW, intervalMs: DAY, horizonBars: 5 }),
    ).toEqual([]);
  });

  it("on the close basis anchors on the entry bar's close and runs one bar further", () => {
    // The entry moment is the close of the bar opening at NOW + DAY, so that
    // bar is the anchor (its own close = 0% at barsSinceEntry 0), and a
    // horizon of 2 spans the entry bar plus two following closes, ending on
    // the bar whose close is the study's measured exit.
    const trace = alignedTracePoints({
      candles,
      entryTime: NOW + 2 * DAY - 1,
      intervalMs: DAY,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
    });
    expect(trace).toEqual([
      { barsSinceEntry: 0, changePct: 0 },
      { barsSinceEntry: 1, changePct: ((110 - 105) / 105) * 100 },
      { barsSinceEntry: 2, changePct: ((104 - 105) / 105) * 100 },
    ]);
  });

  it("the close basis finds the entry bar whichever close-time convention the feed stamps", () => {
    // closeTime = open + interval: the entry moment is exactly the next open.
    expect(
      alignedTracePoints({
        candles,
        entryTime: NOW + 2 * DAY,
        intervalMs: DAY,
        horizonBars: 1,
        entryBasis: "first_closed_bar_after_event",
      })[0],
    ).toEqual({ barsSinceEntry: 0, changePct: 0 });
    // closeTime = open + interval - 1: the entry moment is the last
    // millisecond inside the bar.
    expect(
      alignedTracePoints({
        candles,
        entryTime: NOW + 2 * DAY - 1,
        intervalMs: DAY,
        horizonBars: 1,
        entryBasis: "first_closed_bar_after_event",
      })[0],
    ).toEqual({ barsSinceEntry: 0, changePct: 0 });
  });
});

describe("aggregateAlignedTrace", () => {
  it("averages per bar offset and carries n; ragged traces average what they hold", () => {
    const { points, n } = aggregateAlignedTrace([
      [
        { barsSinceEntry: 0, changePct: 10 },
        { barsSinceEntry: 1, changePct: 20 },
      ],
      [{ barsSinceEntry: 0, changePct: 4 }],
    ]);
    expect(n).toBe(2);
    expect(points).toEqual([
      { barsSinceEntry: 0, changePct: 7 },
      { barsSinceEntry: 1, changePct: 20 },
    ]);
  });

  it("reports n = 0 for no traces rather than an empty mean", () => {
    expect(aggregateAlignedTrace([])).toEqual({ points: [], n: 0 });
  });
});

describe("describeHorizon", () => {
  it("speaks bars and human time together", () => {
    expect(describeHorizon(30, 30 * DAY)).toBe("30 bars (30 days)");
    expect(describeHorizon(7, 7 * DAY)).toBe("7 bars (7 days)");
    expect(describeHorizon(120, 120 * 60 * 60_000)).toBe("120 bars (5 days)");
    expect(describeHorizon(90, 90 * DAY)).toContain("months");
  });
});

describe("nextGraphViewMode (thread-scoped mode-switch state)", () => {
  it("a scene arriving never moves the view: publication is Live-first", () => {
    // The old behavior jumped Live to Calendar on arrival; the unified graph
    // keeps the reader wherever they are and decorates Live instead.
    expect(
      nextGraphViewMode({ current: "live", hasScenes: true, previouslyHadScenes: false }),
    ).toBe("live");
    expect(
      nextGraphViewMode({ current: "calendar", hasScenes: true, previouslyHadScenes: false }),
    ).toBe("calendar");
    expect(
      nextGraphViewMode({ current: "aligned", hasScenes: true, previouslyHadScenes: false }),
    ).toBe("aligned");
  });

  it("never moves a reader who already has scenes, whichever mode they chose", () => {
    for (const current of ["live", "calendar", "aligned"] as const) {
      expect(nextGraphViewMode({ current, hasScenes: true, previouslyHadScenes: true })).toBe(
        current,
      );
    }
  });

  it("returns to Live when the thread holds no scenes: research modes have nothing to show", () => {
    for (const current of ["live", "calendar", "aligned"] as const) {
      expect(nextGraphViewMode({ current, hasScenes: false, previouslyHadScenes: true })).toBe(
        "live",
      );
      expect(nextGraphViewMode({ current, hasScenes: false, previouslyHadScenes: false })).toBe(
        "live",
      );
    }
  });
});

describe("liveResearchMarkers (the live graph's scene decoration)", () => {
  const NOW = 1_800_000_000_000;
  const RULE_AT = NOW - 40 * DAY; // instantaneous activation, in the past
  const SPAN_START = NOW - 200 * DAY;
  const SPAN_END = NOW - 197 * DAY; // a true multi-day span
  const UPCOMING = NOW + 30 * DAY;

  const scene = {
    sceneId: "scene-9",
    eventStudy: {
      eventSetName: "ETH upgrades",
      occurrenceWindows: [
        {
          startAt: SPAN_START,
          endAt: SPAN_END,
          label: "Devcon",
          source: "https://e.org/devcon",
          covered: true,
          entryTime: SPAN_END,
          exitTime: SPAN_END + 30 * DAY,
        },
        {
          startAt: RULE_AT,
          endAt: RULE_AT,
          label: undefined,
          source: "https://e.org/dencun",
          covered: true,
          entryTime: RULE_AT,
          exitTime: RULE_AT + 30 * DAY,
        },
        {
          startAt: UPCOMING,
          endAt: UPCOMING + 3 * DAY,
          label: "Futurera",
          source: "https://e.org/next",
          covered: false,
        },
        {
          startAt: NOW - 3_000 * DAY,
          endAt: NOW - 3_000 * DAY,
          label: "Frontier",
          source: "https://e.org/old",
          covered: false,
        },
      ],
    },
  } as never;

  const markers = liveResearchMarkers(scene, NOW);

  it("derives one marker per occurrence, keyed by scene and exact startAt", () => {
    expect(markers.map((marker) => marker.key)).toEqual([
      `scene-9:${SPAN_START}`,
      `scene-9:${RULE_AT}`,
      `scene-9:${UPCOMING}`,
      `scene-9:${NOW - 3_000 * DAY}`,
    ]);
  });

  it("an exact occurrence keeps its exact millisecond; a true span keeps both instants", () => {
    const rule = markers[1];
    expect(rule?.startAt).toBe(RULE_AT);
    expect(rule?.endAt).toBe(RULE_AT);
    const span = markers[0];
    expect(span?.startAt).toBe(SPAN_START);
    expect(span?.endAt).toBe(SPAN_END);
  });

  it("labels fall back to the event set's name, carry the source, and flag coverage and upcoming", () => {
    expect(markers[1]?.label).toBe("ETH upgrades");
    expect(markers[0]?.label).toBe("Devcon");
    for (const marker of markers) {
      expect(marker.sourceUrl.startsWith("https://e.org/")).toBe(true);
    }
    expect(markers[2]?.upcoming).toBe(true);
    expect(markers[0]?.upcoming).toBe(false);
    expect(markers[2]?.covered).toBe(false);
    expect(markers[0]?.covered).toBe(true);
  });

  it("a scene without an event study decorates nothing", () => {
    expect(liveResearchMarkers({ sceneId: "s" }, NOW)).toEqual([]);
  });

  it("the accessible name says label, exact UTC instant, meaning and source", () => {
    const name = researchMarkerAccessibleName({
      key: "k",
      label: "Dencun",
      startAt: RULE_AT,
      endAt: RULE_AT,
      sourceUrl: "https://e.org/dencun",
      covered: true,
      upcoming: false,
    });
    expect(name).toContain("Dencun");
    expect(name).toContain(new Date(RULE_AT).toISOString());
    expect(name).toContain("historical counterfactual measurement, not a fill");
    expect(name).toContain("https://e.org/dencun");
    const spanName = researchMarkerAccessibleName({
      key: "k2",
      label: "Devcon",
      startAt: SPAN_START,
      endAt: SPAN_END,
      sourceUrl: "https://e.org/devcon",
      covered: true,
      upcoming: false,
    });
    expect(spanName).toContain(`from ${new Date(SPAN_START).toISOString()}`);
    expect(spanName).toContain(`to ${new Date(SPAN_END).toISOString()}`);
  });

  it("uncovered occurrences become coverage notes, never fake edge markers", () => {
    const notes = uncoveredOccurrenceNotes(scene, NOW);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("Futurera");
    expect(notes[0]).toContain("has not happened yet");
    expect(notes[1]).toContain("Frontier");
    expect(notes[1]).toContain(new Date(NOW - 3_000 * DAY).toISOString().slice(0, 10));
    expect(notes[1]).toContain("predates recorded data");
    // Covered occurrences say nothing: they draw, they do not explain.
    expect(uncoveredOccurrenceNotes({}, NOW)).toEqual([]);
  });
});

describe("sceneAutoFitRecommendation and its once-per-scene gate", () => {
  const NOW = Date.UTC(2024, 8, 15); // mid-September 2024: ytd spans ~258 days

  const windows = (starts: ReadonlyArray<number>, covered = true) =>
    starts.map((startAt) => ({ startAt, endAt: startAt, covered }));

  it("the Ethereum-style multi-year scene recommends all with 1 week bars", () => {
    // Three upgrades spread over three years: nothing fixed holds them.
    const recommendation = sceneAutoFitRecommendation(
      windows([NOW - 3 * 365 * DAY, NOW - 2 * 365 * DAY, NOW - 200 * DAY]),
      NOW,
    );
    expect(recommendation.range).toBe("all");
    expect(recommendation.interval).toBe("1w");
  });

  it("a recent scene fits the smallest range that holds it, on study-fit bars", () => {
    const recommendation = sceneAutoFitRecommendation(windows([NOW - 90 * DAY]), NOW);
    expect(recommendation.range).toBe("6m");
    // event_study_fit keeps 6m on weekly bars where browsing would use 1d.
    expect(recommendation.interval).toBe("1w");
  });

  it("occurrences the archive never reached do not stretch the fit", () => {
    // One covered recent occurrence plus one from before recording began:
    // the uncovered one can never draw, so the fit stays on the drawable one.
    const recommendation = sceneAutoFitRecommendation(
      [
        { startAt: NOW - 60 * DAY, endAt: NOW - 60 * DAY, covered: true },
        { startAt: NOW - 2_000 * DAY, endAt: NOW - 2_000 * DAY, covered: false },
      ],
      NOW,
    );
    expect(recommendation.range).toBe("6m");
  });

  it("with nothing drawable, the whole set decides and the fit lands on all", () => {
    const recommendation = sceneAutoFitRecommendation(
      windows([NOW - 400 * DAY, NOW - 800 * DAY], false),
      NOW,
    );
    expect(recommendation.range).toBe("all");
    expect(recommendation.interval).toBe("1w");
  });

  it("applies once per active scene id and never twice for the same one", () => {
    const scene = {
      sceneId: "scene-1",
      eventStudy: { occurrenceWindows: windows([NOW - 3 * 365 * DAY]) },
    } as never;
    const first = sceneAutoFitDecision(new Set(), scene, NOW);
    expect(first.apply).toBe(true);
    expect(first.recommendation).toEqual({ range: "all", interval: "1w" });
    expect(first.appliedSceneIds.has("scene-1")).toBe(true);
    // The second call — the next poll, the next refresh — must not move it.
    const second = sceneAutoFitDecision(first.appliedSceneIds, scene, NOW);
    expect(second.apply).toBe(false);
    expect(second.appliedSceneIds).toBe(first.appliedSceneIds);
    // A NEW scene id (the superseding publish) gets its own one fit.
    const successor = {
      sceneId: "scene-2",
      eventStudy: { occurrenceWindows: windows([NOW - 3 * 365 * DAY]) },
    } as never;
    const third = sceneAutoFitDecision(first.appliedSceneIds, successor, NOW);
    expect(third.apply).toBe(true);
  });

  it("a scene with no event study never fits anything", () => {
    const decision = sceneAutoFitDecision(new Set(), { sceneId: "s" }, NOW);
    expect(decision.apply).toBe(false);
  });
});

describe("baselineReference (the event-aligned comparison's drawn reference)", () => {
  it("is the baseline mean as one labelled level", () => {
    expect(baselineReference({ meanReturnPct: 1.1 })).toEqual({
      valuePct: 1.1,
      label: BASELINE_REFERENCE_LABEL,
    });
    expect(BASELINE_REFERENCE_LABEL).toBe("Baseline mean");
  });

  it("is null when the report holds no baseline: nothing may draw in its place", () => {
    expect(baselineReference(null)).toBeNull();
    expect(BASELINE_UNAVAILABLE_SENTENCE).toBe("Baseline unavailable for this served window");
  });
});

describe("occurrenceWindow", () => {
  it("spans the event plus the measured horizon plus fixed context bars", () => {
    const window = occurrenceWindow(
      { startAt: NOW, endAt: NOW + 4 * DAY, entryTime: NOW + 4 * DAY, exitTime: NOW + 34 * DAY },
      30 * DAY,
      DAY,
    );
    expect(window.startTime).toBe(NOW - 6 * DAY);
    expect(window.endTime).toBe(NOW + 34 * DAY + 6 * DAY);
  });

  it("falls back to the event end when the occurrence was never measured", () => {
    const window = occurrenceWindow({ startAt: NOW, endAt: NOW + DAY }, 30 * DAY, DAY);
    expect(window.endTime).toBe(NOW + DAY + 30 * DAY + 6 * DAY);
  });
});

describe("studyExplanationLines", () => {
  const payload = {
    interval: "1d",
    report: {
      horizonBars: 30,
      horizonMs: 30 * DAY,
      n: 3,
      nCovered: 1,
      meanReturnPct: 4.2,
      medianReturnPct: 4,
      hitRatePercent: 100,
      bestReturnPct: 4.2,
      worstReturnPct: 4.2,
      baseline: { samples: 40, meanReturnPct: 1.1, medianReturnPct: 1 },
      rows: [],
      verdict: "",
    },
    priceSource: "hyperliquid",
    archiveBounds: { recordingSince: NOW - 400 * DAY, fromT: 0, toT: 0 },
  };

  it("carries coverage, horizon in bars and human time, the rule, aggregates, baseline, bounds and source", () => {
    const lines = studyExplanationLines(payload as never);
    expect(lines.some((line) => line.includes("1 of 3 occurrences"))).toBe(true);
    expect(lines.some((line) => line.includes("30 bars (30 days)"))).toBe(true);
    expect(lines.some((line) => line.includes("first archived bar"))).toBe(true);
    expect(lines.some((line) => line.includes("hit rate 100%"))).toBe(true);
    expect(lines.some((line) => line.includes("not a significance test"))).toBe(true);
    expect(lines.some((line) => line.includes("recording since"))).toBe(true);
    expect(lines.some((line) => line.includes("price source: hyperliquid"))).toBe(true);
  });

  it("states the missing baseline honestly instead of omitting it", () => {
    const lines = studyExplanationLines({
      ...payload,
      report: { ...payload.report, baseline: null },
    } as never);
    expect(lines.some((line) => line.includes("no baseline"))).toBe(true);
  });

  it("names the entry basis the scene was measured on, old scenes as the open basis", () => {
    // A payload with no entryBasis is an old scene: it must explain the open
    // basis its numbers were computed on, never a newer convention.
    const openLines = studyExplanationLines(payload as never);
    expect(openLines.some((line) => line.includes("entry basis: open of the first bar"))).toBe(
      true,
    );
    expect(openLines.some((line) => line.includes(STUDY_RULE_SENTENCE))).toBe(true);
    const closeLines = studyExplanationLines({
      ...payload,
      entryBasis: "first_closed_bar_after_event",
    } as never);
    expect(
      closeLines.some((line) => line.includes("entry basis: close of the first closed bar")),
    ).toBe(true);
    expect(closeLines.some((line) => line.includes("close to close"))).toBe(true);
  });

  it("states the requested window and the served window beside each other", () => {
    const lines = studyExplanationLines({
      ...payload,
      requestedFromT: NOW - 30 * DAY,
      requestedToT: NOW,
      archiveBounds: { recordingSince: NOW - 400 * DAY, fromT: NOW - 20 * DAY, toT: NOW },
    } as never);
    const bounds = lines.find((line) => line.startsWith("requested "));
    expect(bounds).toBeDefined();
    expect(bounds).toContain("served ");
    expect(studyExplanationLines(payload as never).some((line) => line.startsWith("served "))).toBe(
      true,
    );
  });
});

describe("the money a study's percentage maps onto", () => {
  it("is a signed gross change on the notional, labelled as historical and before costs", () => {
    expect(grossChangeUsd(5_000, -10)).toBe(-500);
    expect(historicalGrossChangeLabel(5_000)).toBe(
      "historical gross change on $5,000, before costs",
    );
    expect(historicalGrossChangeLabel(1_000)).toBe(
      "historical gross change on $1,000, before costs",
    );
  });

  it("formats USD with a sign only when negative, never parentheses or a balance", () => {
    expect(fmtUsd(-500)).toBe("-$500");
    expect(fmtUsd(500)).toBe("$500");
    expect(fmtUsd(1234.5)).toBe("$1,234.5");
  });
});

describe("studyRuleSentence and payloadEntryBasis", () => {
  it("says the rule in the basis's own words, both bases", () => {
    expect(studyRuleSentence("first_bar_open_after_event")).toBe(STUDY_RULE_SENTENCE);
    const close = studyRuleSentence("first_closed_bar_after_event");
    expect(close).toContain("close of the first bar that closed after the event");
    expect(close).toContain("close to close");
  });

  it("reads a payload without a basis as the open basis", () => {
    expect(payloadEntryBasis({} as never)).toBe("first_bar_open_after_event");
    expect(payloadEntryBasis({ entryBasis: "first_closed_bar_after_event" } as never)).toBe(
      "first_closed_bar_after_event",
    );
  });
});

describe("occurrenceStudyOverlay (the calendar chart's semantic layers)", () => {
  const layers = [
    { kind: "event_span", startAt: 1, endAt: 1, label: "Merge / Paris", occurrenceIndex: 0 },
    { kind: "event_span", startAt: 2, endAt: 9, label: "Devcon", occurrenceIndex: 1 },
    { kind: "study_entry", at: 101, price: 1470.12, occurrenceIndex: 0 },
    { kind: "study_exit", at: 801, price: 1552.3, occurrenceIndex: 0 },
    { kind: "return_span", fromT: 101, toT: 801, returnPct: 5.59, occurrenceIndex: 0 },
  ] as const;

  it("binds the occurrence's own layers by index: named activation, entry, exit, return", () => {
    const overlay = occurrenceStudyOverlay(layers, 0, 30);
    expect(overlay.activation).toEqual({ at: 1, label: "Merge / Paris" });
    expect(overlay.entry).toEqual({ at: 101, price: 1470.12, label: "study entry" });
    expect(overlay.exit).toEqual({ at: 801, price: 1552.3, label: "study exit after 30 bars" });
    expect(overlay.returnPct).toBe(5.59);
  });

  it("carries the horizon in the exit label, whatever the horizon was", () => {
    expect(occurrenceStudyOverlay(layers, 0, 7).exit?.label).toBe("study exit after 7 bars");
  });

  it("leaves absent pieces null for an unmeasured occurrence: no invented marker", () => {
    const overlay = occurrenceStudyOverlay(layers, 1, 30);
    expect(overlay.activation).toEqual({ at: 9, label: "Devcon" });
    expect(overlay.entry).toBeNull();
    expect(overlay.exit).toBeNull();
    expect(overlay.returnPct).toBeNull();
  });

  it("returns all-null for an occurrence the scene holds nothing for", () => {
    expect(occurrenceStudyOverlay(layers, 5, 30)).toEqual({
      activation: null,
      entry: null,
      exit: null,
      returnPct: null,
    });
  });
});

describe("provenance and marker vocabulary", () => {
  it("trails researched facts to the scene and states the not-created tail honestly", () => {
    const line = provenanceTrailLine({
      eventSetName: "Devcon",
      interval: "1d",
      priceSource: "hyperliquid",
      report: { nCovered: 1, n: 2 },
    } as never);
    expect(line).toContain("researched dates");
    expect(line).toContain('event set "Devcon"');
    expect(line).toContain("1/2 measured");
    expect(line).toContain("not created");
    expect(line).toContain("explicit ask");
  });

  it("separates counterfactual bands from paper and fills, and claims no fill", () => {
    expect(MARKER_LEGEND_SENTENCE).toContain("historical counterfactual");
    expect(MARKER_LEGEND_SENTENCE).toContain("paper validation");
    expect(MARKER_LEGEND_SENTENCE).toContain("exchange fills");
    expect(MARKER_LEGEND_SENTENCE).toContain("nothing in this view is a fill");
  });
});

describe("prefill sentences", () => {
  it("ask-about names the artifact, occurrence, date and measurement without auto-sending", () => {
    const sentence = askAboutOccurrenceSentence({
      sceneId: "scene-123456",
      market: "ETH",
      label: "Devcon SEA",
      dateIso: "2024-11-12",
      returnPct: -2.5,
    });
    expect(sentence).toContain("scene-12");
    expect(sentence).toContain("Devcon SEA");
    expect(sentence).toContain("2024-11-12");
    expect(sentence).toContain("-2.50%");
    expect(sentence).toContain("which bars produced that number");
  });

  it("next steps are asks, never actions: both sentences forbid arming or planning on click", () => {
    expect(turnIntoStrategySentence("ETH", "Devcon")).toContain("Do not publish a plan");
    expect(validateForwardSentence("ETH", "Devcon")).toContain("paper");
    expect(validateForwardSentence("ETH", "Devcon")).toContain("nothing live");
  });

  it("the derived-vs-authored sentence separates server numbers from agent prose", () => {
    expect(DERIVED_VS_AUTHORED_SENTENCE).toContain("computed by the server");
    expect(DERIVED_VS_AUTHORED_SENTENCE).toContain("never measurements");
  });
});

describe("studyWindowMaxBars (the chart window a recipe derives)", () => {
  const DAY1D = DAY;

  it("a long-horizon scene derives more than 360 bars: the entry must survive the read", () => {
    // A 500-bar horizon on a one-day event window: the window read keeps the
    // NEWEST bars when it cuts, so anything below event-span + horizon +
    // context drops the oldest bars — the entry. 360 would truncate it.
    const bars = studyWindowMaxBars({
      startAt: NOW,
      endAt: NOW + DAY1D,
      horizonBars: EVENT_STUDY_MAX_HORIZON_BARS,
      intervalMs: DAY1D,
    });
    expect(bars).toBeGreaterThan(360);
    expect(bars).toBeLessThanOrEqual(STUDY_CHART_MAX_WINDOW_BARS);
    // Event span (1) + horizon (500) + context (12) = 513, clamped to 512.
    expect(bars).toBe(STUDY_CHART_MAX_WINDOW_BARS);
  });

  it("a small horizon asks only for what its window spans", () => {
    const bars = studyWindowMaxBars({
      startAt: NOW,
      endAt: NOW + DAY1D,
      horizonBars: 30,
      intervalMs: DAY1D,
    });
    expect(bars).toBe(30 + 1 + 12);
  });

  it("the entry and exit bars of a measured window stay inside the fetch", () => {
    // The window the graph fetches pads the event span with context bars on
    // both sides; the derivation asks for event span + horizon + both pads —
    // never less than the window it serves.
    const spanBars = 3;
    const horizonBars = 30;
    const windowBars = spanBars + horizonBars + 2 * OCCURRENCE_CONTEXT_BARS; // the pads occurrenceWindow spans
    const asked = studyWindowMaxBars({
      startAt: NOW,
      endAt: NOW + spanBars * DAY1D,
      horizonBars,
      intervalMs: DAY1D,
    });
    expect(asked).toBe(windowBars);
    expect(asked).toBeGreaterThanOrEqual(spanBars + horizonBars);
  });
});

describe("the displayed measurement rule", () => {
  it("says the counting is inclusive, matching horizon 1 and horizon 2 in the engine", () => {
    // The engine exits on entryIndex + horizonBars - 1: horizon 1 exits on
    // the entry bar's own close, horizon 2 on the next bar's. The sentence
    // must say "counting the entry as the first", never "N bars later".
    expect(STUDY_RULE_SENTENCE).toContain("counting the entry as the first");
    expect(STUDY_RULE_SENTENCE).not.toContain("bars later");
  });
});

describe("activeGraphScenes", () => {
  const sceneWith = (status: "active" | "superseded" | "cleared") =>
    ({
      sceneId: `scene-${status}`,
      status,
      referenceStatus: "ok",
      threadId: "thread-1",
      kind: "annotated_market",
      title: "a note",
      createdAt: NOW,
      updatedAt: NOW,
      calculationVersion: "v1",
      disclaimer: RESEARCH_DISCLAIMER,
      annotation: { market: "ETH", at: NOW, text: "note" },
    }) as import("./researchSceneViewTypes.ts").ResearchSceneView;

  it("keeps only active scenes: cleared and superseded leave the graph", () => {
    const kept = activeGraphScenes([
      sceneWith("active"),
      sceneWith("cleared"),
      sceneWith("superseded"),
    ]);
    expect(kept.map((scene) => scene.sceneId)).toEqual(["scene-active"]);
  });

  it("hands an empty graph back when everything was cleared or superseded", () => {
    expect(activeGraphScenes([sceneWith("cleared"), sceneWith("superseded")])).toEqual([]);
  });
});
