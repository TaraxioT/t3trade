import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import type { EventStudyReport } from "./eventSets.ts";

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

const payload: EventStudyScenePayload = {
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

describe("the recipe and its illustration", () => {
  it("accepts an illustrative notional and the requested window, and defaults the price source", () => {
    const decode = Schema.decodeUnknownSync(EventStudyScenePayload);
    expect(
      decode({ ...payload, illustrativeNotionalUsd: 1000, requestedFromT: 0, requestedToT: NOW })
        .illustrativeNotionalUsd,
    ).toBe(1000);
    expect(decode(payload).priceSource).toBe("hyperliquid");
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
        deterministic: [{ kind: "event_span", startAt: 0, endAt: 1, label: "e" }],
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
    expect(RESEARCH_CALCULATION_VERSIONS.eventStudy).toBe("event-study-1");
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
  });
});
