import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import type { EventStudyReport, EventStudyRow } from "./eventSets.ts";

import {
  EventStudyScenePayload,
  RESEARCH_CALCULATION_VERSIONS,
  RESEARCH_DISCLAIMER,
  SCENE_MAX_JSON_CHARS,
  SCENE_MAX_LABEL_CHARS,
  SCENE_MAX_LAYERS,
  SCENE_MAX_TEXT_CHARS,
  TradingChartScene,
  composeEventStudyScene,
  renderTradingChartMenu,
  validateTradingChartScene,
} from "./researchScenes.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;

const coveredRow = (index: number, returnPct: number) => ({
  startAt: NOW - (index + 2) * DAY,
  endAt: NOW - (index + 1) * DAY,
  covered: true,
  reason: undefined,
  entryTime: NOW - (index + 1) * DAY,
  entryPrice: 100,
  exitTime: NOW - (index + 1) * DAY + 30 * DAY,
  exitPrice: 100 + returnPct,
  returnPct,
  truncated: false,
  barsCovered: 30,
  source: `https://example.com/${index}`,
});

const report: EventStudyReport = {
  horizonBars: 30,
  horizonMs: 30 * DAY,
  n: 2,
  nCovered: 2,
  meanReturnPct: 5,
  medianReturnPct: 5,
  hitRatePercent: 100,
  bestReturnPct: 10,
  worstReturnPct: 0,
  baseline: { samples: 40, meanReturnPct: 1, medianReturnPct: 1 },
  rows: [coveredRow(0, 10), coveredRow(1, 0)],
  verdict: "2 of 2 occurrences fall inside archived data.",
};

// The persisted document as an OLD scene stored it: no entryBasis field,
// because the field did not exist when the scene was computed.
const payloadBeforeBasis = {
  priceSource: "hyperliquid",
  eventSetId: "set-1",
  eventSetName: "Devcon",
  market: "ETH",
  interval: "1d",
  horizonBars: 30,
  report,
  occurrenceWindows: [],
  archiveBounds: { recordingSince: NOW - 400 * DAY, fromT: NOW - 400 * DAY, toT: NOW },
};

const payload: EventStudyScenePayload =
  Schema.decodeUnknownSync(EventStudyScenePayload)(payloadBeforeBasis);

describe("the recipe and its illustration", () => {
  it("accepts an illustrative notional and the requested window, and defaults the price source", () => {
    const decode = Schema.decodeUnknownSync(EventStudyScenePayload);
    expect(
      decode({ ...payload, illustrativeNotionalUsd: 1000, requestedFromT: 0, requestedToT: NOW })
        .illustrativeNotionalUsd,
    ).toBe(1000);
    expect(decode(payload).priceSource).toBe("hyperliquid");
  });

  it("persists the entry basis, and decodes a scene recorded before the field as the open basis", () => {
    const decode = Schema.decodeUnknownSync(EventStudyScenePayload);
    // A scene written before entryBasis existed: its numbers were computed on
    // the open basis and must decode as that, never reinterpreted.
    expect(decode(payloadBeforeBasis).entryBasis).toBe("first_bar_open_after_event");
    expect(payload.entryBasis).toBe("first_bar_open_after_event");
    expect(
      decode({ ...payloadBeforeBasis, entryBasis: "first_closed_bar_after_event" }).entryBasis,
    ).toBe("first_closed_bar_after_event");
  });
});

describe("composeEventStudyScene", () => {
  it("derives spans, entries, exits, return spans and the baseline from the report, never inventing values", () => {
    const scene = composeEventStudyScene(payload);
    expect(scene.kind).toBe("event_study");
    expect(scene.viewport.kind).toBe("event_aligned");
    expect(scene.disclaimer).toBe(RESEARCH_DISCLAIMER);
    expect(scene.deterministic.filter((layer) => layer.kind === "event_span")).toHaveLength(2);
    expect(scene.deterministic.filter((layer) => layer.kind === "study_entry")).toHaveLength(2);
    expect(scene.deterministic.filter((layer) => layer.kind === "study_exit")).toHaveLength(2);
    const returns = scene.deterministic.filter((layer) => layer.kind === "return_span");
    expect(returns.map((layer) => (layer.kind === "return_span" ? layer.returnPct : 0))).toEqual([
      10, 0,
    ]);
    expect(scene.deterministic.some((layer) => layer.kind === "line")).toBe(true);
    expect(scene.sources).toEqual(["https://example.com/0", "https://example.com/1"]);
    // Every layer carries the row it belongs to, so the graph can bind an
    // occurrence's span, entry, exit and return without guessing by order.
    const spans = scene.deterministic.filter((layer) => layer.kind === "event_span");
    expect(
      spans.map((layer) => (layer.kind === "event_span" ? layer.occurrenceIndex : -1)),
    ).toEqual([0, 1]);
    const firstEntry = scene.deterministic.find(
      (layer) => layer.kind === "study_entry" && layer.occurrenceIndex === 0,
    );
    expect(firstEntry).toBeDefined();
  });

  it("contributes no entry, exit, or return for an unmeasured occurrence", () => {
    const scene = composeEventStudyScene({
      ...payload,
      report: {
        ...report,
        nCovered: 1,
        rows: [
          report.rows[0] as never,
          {
            ...coveredRow(1, 0),
            covered: false,
            reason: "still in the future",
            entryTime: undefined,
            entryPrice: undefined,
            exitTime: undefined,
            exitPrice: undefined,
            returnPct: undefined,
            barsCovered: undefined,
          },
        ],
      },
    });
    expect(scene.deterministic.filter((layer) => layer.kind === "study_entry")).toHaveLength(1);
    expect(scene.deterministic.filter((layer) => layer.kind === "return_span")).toHaveLength(1);
  });

  it("produces scenes the validator accepts", () => {
    const scene = { ...composeEventStudyScene(payload), sceneId: "s1" };
    expect(validateTradingChartScene(scene)).toBeNull();
  });
});

describe("validateTradingChartScene", () => {
  const scene = (overrides?: Partial<TradingChartScene>): TradingChartScene => ({
    sceneId: "s1",
    kind: "event_study",
    viewport: { kind: "live" },
    deterministic: [],
    authored: [],
    sources: [],
    disclaimer: RESEARCH_DISCLAIMER,
    ...overrides,
  });

  it("refuses more layers than the cap", () => {
    const layers = Array.from({ length: SCENE_MAX_LAYERS + 1 }, (_, index) => ({
      kind: "label" as const,
      at: NOW,
      text: `note ${index}`,
    }));
    expect(validateTradingChartScene(scene({ authored: layers }))).toContain(
      `${SCENE_MAX_LAYERS} layers`,
    );
  });

  it("refuses empty and over-long authored text", () => {
    expect(
      validateTradingChartScene(scene({ authored: [{ kind: "note", at: NOW, text: "  " }] })),
    ).toContain("authored layer");
    expect(
      validateTradingChartScene(
        scene({
          authored: [{ kind: "label", at: NOW, text: "x".repeat(SCENE_MAX_LABEL_CHARS + 1) }],
        }),
      ),
    ).toContain(`${SCENE_MAX_LABEL_CHARS}`);
    expect(
      validateTradingChartScene(
        scene({
          authored: [{ kind: "note", at: NOW, text: "x".repeat(SCENE_MAX_TEXT_CHARS + 1) }],
        }),
      ),
    ).toContain(`${SCENE_MAX_TEXT_CHARS}`);
  });

  it("refuses an oversized serialized payload", () => {
    const big = scene({
      authored: [{ kind: "note", at: NOW, text: "x".repeat(SCENE_MAX_TEXT_CHARS) }],
    });
    expect(SCENE_MAX_JSON_CHARS).toBeGreaterThan(JSON.stringify(big).length);
    const huge = {
      ...big,
      sources: ["x".repeat(SCENE_MAX_JSON_CHARS)],
    } as unknown as TradingChartScene;
    expect(validateTradingChartScene(huge)).toContain("under");
  });
});

describe("the model never writes computed values or rendering instructions", () => {
  const decodeScene = Schema.decodeUnknownSync(TradingChartScene);

  it("accepts the typed union", () => {
    expect(() =>
      decodeScene({
        sceneId: "s",
        kind: "event_study",
        viewport: { kind: "window", fromT: 0, toT: 1 },
        deterministic: [
          { kind: "event_span", startAt: 0, endAt: 1, label: "e", occurrenceIndex: 0 },
        ],
        authored: [],
        sources: [],
        disclaimer: RESEARCH_DISCLAIMER,
      }),
    ).not.toThrow();
  });

  it("rejects raw markup, scripts, styles, and arbitrary coordinates as layers", () => {
    for (const junk of [
      { kind: "svg", markup: "<circle cx=1 cy=1 r=1/>" },
      { kind: "html", html: "<b>bold</b>" },
      { kind: "style", css: "body{color:red}" },
      { kind: "script", js: "alert(1)" },
      { kind: "point", x: 12, y: 34 },
      { kind: "custom_return", returnPct: 900 },
    ]) {
      const attempt = {
        sceneId: "s",
        kind: "event_study",
        viewport: { kind: "live" },
        deterministic: [junk],
        authored: [],
        sources: [],
        disclaimer: RESEARCH_DISCLAIMER,
      };
      expect(() => decodeScene(attempt)).toThrow();
    }
  });
});

describe("calculation versions and menu", () => {
  it("pins one version per engine and names every action in the menu", () => {
    // Bumped when the study gained an explicit entry basis, then again when
    // it gained the path_extrema metric and occurrence time precision.
    expect(RESEARCH_CALCULATION_VERSIONS.eventStudy).toBe("event-study-3");
    const menu = renderTradingChartMenu();
    for (const action of [
      "publish_event_study",
      "publish_strategy_replay",
      "annotate",
      "show",
      "list",
      "clear",
    ]) {
      expect(menu).toContain(action);
    }
    // The metric fields ride the publish call shape.
    expect(menu).toContain("metric?");
    expect(menu).toContain("direction?");
    expect(menu).toContain("priceField?");
    expect(menu).toContain("path_extrema");
  });

  it("shows the publish call shape the model must use, including the basis and the notional", () => {
    const menu = renderTradingChartMenu();
    for (const field of ["entryBasis", "illustrativeNotionalUsd", "first_closed_bar_after_event"]) {
      expect(menu).toContain(field);
    }
    // Publishing returns the scene on the graph: the model must not call
    // show afterwards, and the menu says so next to the shape it shows.
    expect(menu).toContain("no follow-up show call");
    expect(menu).toContain("show {sceneId}");
  });
});

describe("the path_extrema recipe and its decode compatibility", () => {
  const decode = Schema.decodeUnknownSync(EventStudyScenePayload);

  it("persists the metric, direction and price field, and its report's extrema ride the rows", () => {
    const decoded = decode({
      ...payloadBeforeBasis,
      entryBasis: "first_closed_bar_after_event",
      metric: "path_extrema",
      direction: "short",
      priceField: "low",
      illustrativeNotionalUsd: 2000,
      report: {
        ...report,
        metric: "path_extrema",
        meanExcursionPct: -12.5,
        excursionBeyondTerminalPercent: 100,
        rows: report.rows.map((row) => ({
          ...row,
          extremumTime: row.entryTime,
          extremumPrice: 87.5,
          excursionReturnPct: -12.5,
        })),
      },
    });
    expect(decoded.metric).toBe("path_extrema");
    expect(decoded.direction).toBe("short");
    expect(decoded.priceField).toBe("low");
    expect(decoded.report.metric).toBe("path_extrema");
    expect(decoded.report.meanExcursionPct).toBe(-12.5);
    expect(decoded.report.excursionBeyondTerminalPercent).toBe(100);
    expect(decoded.report.rows[0]?.extremumPrice).toBe(87.5);
    expect(decoded.report.rows[0]?.excursionReturnPct).toBe(-12.5);
  });

  it("decodes an old event-study-2 payload as a forward_return study of spans", () => {
    // A scene persisted before metrics or time precision existed: no metric,
    // no direction, no extrema, no precision on any row or window. It must
    // decode with defaults, never be reinterpreted as extrema it never held.
    const decoded = decode(payloadBeforeBasis);
    expect(decoded.metric).toBe("forward_return");
    expect(decoded.direction).toBeUndefined();
    expect(decoded.priceField).toBeUndefined();
    expect(decoded.report.metric).toBeUndefined();
    expect(decoded.report.meanExcursionPct).toBeUndefined();
    expect(decoded.occurrenceWindows).toEqual([]);
    for (const row of decoded.report.rows) {
      expect(row.extremumTime).toBeUndefined();
      expect(row.extremumPrice).toBeUndefined();
      expect(row.excursionReturnPct).toBeUndefined();
      expect(row.timePrecision).toBeUndefined();
    }
  });

  it("carries each occurrence's time precision into the windows", () => {
    const decoded = decode({
      ...payloadBeforeBasis,
      occurrenceWindows: [
        {
          startAt: NOW,
          endAt: NOW,
          timePrecision: "instant",
          source: "https://example.com/i",
          covered: true,
          entryTime: NOW,
          exitTime: NOW + 30 * DAY,
        },
        {
          startAt: NOW + DAY,
          endAt: NOW + 2 * DAY,
          timePrecision: "date",
          source: "https://example.com/d",
          covered: false,
        },
      ],
    });
    expect(decoded.occurrenceWindows.map((window) => window.timePrecision)).toEqual([
      "instant",
      "date",
    ]);
  });
});

describe("composeEventStudyScene and time precision", () => {
  it("an instant occurrence emits no zero-width event_span; its entry marker carries the moment", () => {
    const scene = composeEventStudyScene({
      ...payload,
      report: {
        ...report,
        rows: [
          {
            ...(report.rows[0] as EventStudyRow),
            startAt: NOW,
            endAt: NOW,
            timePrecision: "instant",
            covered: true,
            entryTime: NOW,
            entryPrice: 100,
            exitTime: NOW + 30 * DAY,
            exitPrice: 110,
            returnPct: 10,
          } as never,
        ],
      },
    });
    const spans = scene.deterministic.filter((layer) => layer.kind === "event_span");
    expect(spans).toHaveLength(0);
    const entry = scene.deterministic.find(
      (layer) => layer.kind === "study_entry" && layer.occurrenceIndex === 0,
    );
    expect(entry).toMatchObject({ kind: "study_entry", at: NOW, price: 100 });
    // The source still rides the scene even when the span does not.
    expect(scene.sources).toContain("https://example.com/0");
  });

  it("a date-precision occurrence keeps its day span; a legacy span with no precision claim keeps its band", () => {
    const scene = composeEventStudyScene({
      ...payload,
      report: {
        ...report,
        rows: [
          // Date precision: a whole UTC day, band stays, precision rides the
          // payload's windows for the presenter to label.
          {
            ...(report.rows[0] as EventStudyRow),
            timePrecision: "date",
          } as never,
          // Legacy: no precision claimed, a genuine multi-day span.
          {
            ...(report.rows[1] as EventStudyRow),
            timePrecision: undefined,
          } as never,
        ],
      },
    });
    const spans = scene.deterministic.filter((layer) => layer.kind === "event_span");
    expect(spans).toHaveLength(2);
    // Even a legacy zero-width span keeps its band: the rule names instants
    // by their CLAIMED precision, never by guessing from the timestamps.
    const zeroWidth = composeEventStudyScene({
      ...payload,
      report: {
        ...report,
        rows: [
          {
            ...(report.rows[0] as EventStudyRow),
            startAt: NOW,
            endAt: NOW,
            timePrecision: undefined,
          } as never,
        ],
      },
    });
    expect(zeroWidth.deterministic.filter((layer) => layer.kind === "event_span")).toHaveLength(1);
  });
});
