/**
 * Research scenes: the durable record of what the graph is showing.
 *
 * A study used to be a tool result that died in the transcript. The numbers
 * were honest, and then they were gone: nothing put them on the chart, and a
 * thread that wanted to see its own research again had to re-run it. A
 * research scene is the missing half: one compact, thread-scoped artifact
 * that says what was computed, from what recipe, over what archived window,
 * at which calculation version, so the graph above the conversation can draw
 * it any time without asking anyone to re-derive it.
 *
 * What a scene deliberately does NOT hold is candles. The archive owns the
 * bars, the scene owns the pointer: per-occurrence windows narrow enough that
 * the client reads each one through the ordinary windowed chart request. A
 * scene that carried its own copy of the series would drift from the archive
 * the moment recording repaired a gap, and a copy years wide would be the
 * bulk export the chart caps exist to prevent.
 *
 * ## Three modes, one artifact
 *
 * The same event study answers two different questions depending on the
 * lens. In calendar time the occurrences sit where they happened, years
 * apart, and the entry and exit bars of each are visible as bars. Aligned at
 * the event, every occurrence rebases to its own measured entry, and the
 * question stops being "what happened next" and starts being "do these
 * shapes resemble each other". The scene serves both because it stores each
 * occurrence's measured window, not a rendering.
 *
 * ## Computed versus authored
 *
 * Every number in a scene was computed by the deterministic study or
 * backtest engine from archived bars. An annotation is the one authored
 * thing: a note a model or user pinned to a moment, and it renders with a
 * label saying so, because prose beside numbers is only honest when the
 * reader can tell which is which.
 *
 * ## The sentence that rides every scene
 *
 * {@link RESEARCH_DISCLAIMER} is fixed and travels with every view: a
 * historical counterfactual is not a forecast, and a scene that measured what
 * happened after Devcon has still placed no order and promised nothing.
 *
 * @module TradingResearchScenes
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BacktestInterval, TradingThesis } from "./thesis.ts";
import {
  EventStudyDirection,
  EventStudyEntryBasis,
  EventStudyMetric,
  EventStudyPriceField,
  EventStudyReport,
  EVENT_STUDY_DEFAULT_ENTRY_BASIS,
  EVENT_STUDY_DEFAULT_HORIZON_BARS,
  EVENT_STUDY_ENTRY_BASIS_PHRASES,
  EVENT_STUDY_MAX_HORIZON_BARS,
  TradingEventTimePrecision,
} from "./eventSets.ts";
import { TradingMarket, UnixMillis } from "./primitives.ts";

/** The semantic research presentation tool. Publishes; never trades. */
export const TRADING_CHART_TOOL = "trading_chart";

/** Scenes one thread may hold. Older scenes of the same kind are evicted. */
export const RESEARCH_SCENES_MAX_PER_THREAD = 8;

/** Trade markers one replay scene persists, enough to draw the run. */
export const RESEARCH_SCENE_MAX_TRADES = 200;

/**
 * The one sentence that travels with every scene view. Fixed, not composed:
 * the graph renders research, and research has to disclaim itself the same
 * way every time or the one time it is missing reads as a promise.
 */
export const RESEARCH_DISCLAIMER = "Historical research. No order placed. Not a forecast.";

/**
 * The label beside any money derived from an event study's percentage
 * returns. The percentages are measured; multiplying them by a notional is
 * illustration, gross of fees, and says so rather than dressing up as a PnL.
 * A cost-aware strategy replay is the backtest engine's job, and a replay
 * scene says which engine produced it.
 */
export const PER_NOTIONAL_ILLUSTRATION_LABEL =
  "per-notional illustration, gross, no fees; a cost-aware replay is trading_backtest's job";

/**
 * Bars of context the calendar view pads around a measured occurrence window,
 * so the entry and exit bars sit inside a chart rather than on its edge.
 * Exported because the chart read's `maxBars` is derived from it: a window
 * fetched with fewer bars than event-span + horizon + context silently drops
 * its OLDEST bars (the read keeps the newest), and the oldest bars of a
 * study window are the entry.
 */
export const STUDY_CHART_CONTEXT_BARS = 6;

/**
 * The ceiling a study-derived chart window may ask for: the widest horizon a
 * recipe may declare, plus context on both sides. The chart RPC clamps to
 * this so a client cannot turn it into a bulk history export, while a valid
 * long-horizon scene can still fetch its own entry bar.
 */
export const STUDY_CHART_MAX_WINDOW_BARS =
  EVENT_STUDY_MAX_HORIZON_BARS + 2 * STUDY_CHART_CONTEXT_BARS;

/** Calculation versions, one per kind, bumped when the math changes. */
export const RESEARCH_CALCULATION_VERSIONS = {
  // Bumped to -2 when the study gained an explicit entry basis: scenes
  // computed before the field exist decode as the open basis and keep the
  // numbers they were computed with.
  // Bumped to -3 when the study gained the path_extrema metric (per-row
  // extrema and excursion aggregates) and occurrence time precision: scenes
  // computed before both decode as forward_return studies of spans, exactly
  // what they were.
  eventStudy: "event-study-3",
  strategyReplay: "backtest-replay-1",
  annotation: "annotation-1",
} as const;

/** What the engine could see of the archive when the scene was computed. */
export const ResearchArchiveBounds = Schema.Struct({
  /** When recording started for the series, null when nothing is recorded. */
  recordingSince: Schema.NullOr(UnixMillis),
  /** The first bar the computation actually read. */
  fromT: UnixMillis,
  /** The last bar the computation actually read. */
  toT: UnixMillis,
});
export type ResearchArchiveBounds = typeof ResearchArchiveBounds.Type;

// ---------------------------------------------------------------------------
// the payloads a scene persists: recipe plus deterministic output summary
// ---------------------------------------------------------------------------

/** One occurrence as the graph needs it: the window, and what was measured. */
export const ResearchOccurrenceWindow = Schema.Struct({
  startAt: UnixMillis,
  endAt: UnixMillis,
  /**
   * What the occurrence's timestamps claim (instant/window/date), carried from
   * the occurrence so the graph never guesses a moment a date-only source
   * never established. Absent on windows recorded before the field existed:
   * those occurrences were recorded as spans, and presenters read exactly
   * that, never a fabricated midnight certainty.
   */
  timePrecision: Schema.optional(TradingEventTimePrecision),
  label: Schema.optional(Schema.String),
  source: Schema.String,
  covered: Schema.Boolean,
  /** Present when covered: where entry and exit were measured. */
  entryTime: Schema.optional(UnixMillis),
  exitTime: Schema.optional(UnixMillis),
});
export type ResearchOccurrenceWindow = typeof ResearchOccurrenceWindow.Type;

/** The event-study scene: the recipe, and the engine's whole report. */
export const EventStudyScenePayload = Schema.Struct({
  /**
   * The one price source every bar in this scene came from. A single word
   * today ("hyperliquid"); if a second adapter is ever approved, a
   * mixed-source study must name the source per occurrence instead of
   * aggregating silently, and that rule lives in the adapter decision
   * record (docs/internals).
   */
  priceSource: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("hyperliquid"))),
  /**
   * The notional the user asked to illustrate against, when they did. Part
   * of the RECIPE, not the result: the returns are the deterministic output,
   * and any money figure the graph shows is display arithmetic on them,
   * labelled as a gross, feeless illustration.
   */
  illustrativeNotionalUsd: Schema.optional(Schema.Number),
  /**
   * How the study priced its entry. Part of the recipe like the notional: the
   * report's numbers were computed on this basis and read differently without
   * it. Decodes as `first_bar_open_after_event` when absent, because scenes
   * persisted before the field existed were computed on that basis and must
   * never be reinterpreted.
   */
  entryBasis: EventStudyEntryBasis.pipe(
    Schema.withDecodingDefault(Effect.succeed("first_bar_open_after_event")),
  ),
  /**
   * The metric the study measured. Part of the recipe like the basis: a
   * path_extrema report's extrema and excursion aggregates read as nothing at
   * all without it. Decodes as `forward_return` when absent, because scenes
   * persisted before metrics existed were forward-return studies and must
   * never be reinterpreted. The per-row extrema live on the report's own rows
   * (`extremumTime`/`extremumPrice`/`excursionReturnPct`); no USD figure is
   * persisted — every notional-derived number is presentation-layer
   * arithmetic on the current notional, labelled as such where it renders.
   */
  metric: EventStudyMetric.pipe(Schema.withDecodingDefault(Effect.succeed("forward_return"))),
  /** Present when metric is path_extrema: the side whose favorable excursion the extrema measure. */
  direction: Schema.optional(EventStudyDirection),
  /** Present when metric is path_extrema: the price field the extrema read (low for a short, high for a long). */
  priceField: Schema.optional(EventStudyPriceField),
  /** The archive window the recipe asked about, before coverage answered. */
  requestedFromT: Schema.optional(Schema.Number),
  requestedToT: Schema.optional(Schema.Number),
  eventSetId: Schema.String,
  eventSetName: Schema.String,
  market: TradingMarket,
  interval: BacktestInterval,
  horizonBars: Schema.Number,
  report: EventStudyReport,
  occurrenceWindows: Schema.Array(ResearchOccurrenceWindow),
  archiveBounds: ResearchArchiveBounds,
});
export type EventStudyScenePayload = typeof EventStudyScenePayload.Type;

/** One replay trade as the graph draws it. */
export const ResearchReplayTradeMarker = Schema.Struct({
  entryTime: UnixMillis,
  entryPrice: Schema.Number,
  exitTime: UnixMillis,
  exitPrice: Schema.Number,
  exitReason: Schema.String,
  netUsd: Schema.Number,
});
export type ResearchReplayTradeMarker = typeof ResearchReplayTradeMarker.Type;

/**
 * The strategy-replay scene: a cost-aware backtest, summarized for the
 * graph. The full report stays in the backtest engine's own result; the
 * scene keeps what a reader points at: the verdict, the headline numbers,
 * the coverage, and the trades as markers.
 */
export const StrategyReplayScenePayload = Schema.Struct({
  thesis: TradingThesis,
  notionalUsd: Schema.Number,
  interval: BacktestInterval,
  /** The report's own one-line reasons, verbatim. */
  verdict: Schema.String,
  verdictReason: Schema.String,
  tradesTaken: Schema.Number,
  winRatePercent: Schema.Number,
  /** Net per trade after every fee and funding payment. */
  expectancyUsd: Schema.Number,
  totalFeesUsd: Schema.Number,
  trades: Schema.Array(ResearchReplayTradeMarker),
  archiveBounds: ResearchArchiveBounds,
});
export type StrategyReplayScenePayload = typeof StrategyReplayScenePayload.Type;

/** A pinned note. The one authored layer; renders labelled as authored. */
export const AnnotationScenePayload = Schema.Struct({
  market: TradingMarket,
  at: UnixMillis,
  text: Schema.String,
});
export type AnnotationScenePayload = typeof AnnotationScenePayload.Type;

/** The three things a scene can be. Discriminated by `kind` on the row. */
/**
 * The artifact lifecycle. Exactly one `active` scene exists per thread and
 * market: publishing supersedes the previous one in the same transaction,
 * history stays queryable, and clearing is a presentation state change that
 * touches no other system.
 */
export const ResearchSceneStatus = Schema.Literals(["active", "superseded", "cleared"]);
export type ResearchSceneStatus = typeof ResearchSceneStatus.Type;

export const ResearchSceneKind = Schema.Literals([
  "event_study",
  "strategy_replay",
  "annotated_market",
]);
export type ResearchSceneKind = typeof ResearchSceneKind.Type;

// ---------------------------------------------------------------------------
// the wire view the graph renders
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the composed scene: viewports and layers the graph renders
// ---------------------------------------------------------------------------

/** Layers one scene may hold. Layers beyond the cap are refused, not drawn. */
export const SCENE_MAX_LAYERS = 64;
/** Longest text any layer or annotation may carry. */
export const SCENE_MAX_TEXT_CHARS = 500;
/** Longest short label (axis/band/point tags). */
export const SCENE_MAX_LABEL_CHARS = 120;
/** Occurrence rows one composed scene may reference. */
export const SCENE_MAX_OCCURRENCES = 200;
/** Whole scene payload ceiling, serialized. A scene is a document, not a dataset. */
export const SCENE_MAX_JSON_CHARS = 65_536;

/**
 * What the graph is looking at. `live` follows the newest bar; `window` is a
 * closed historical span (a replay, one occurrence's calendar window);
 * `event_aligned` rebases every occurrence to its measured entry so the
 * question becomes whether the shapes resemble each other.
 */
export const SceneViewport = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("live") }),
  Schema.Struct({ kind: Schema.Literal("window"), fromT: UnixMillis, toT: UnixMillis }),
  Schema.Struct({ kind: Schema.Literal("event_aligned"), anchorAt: UnixMillis }),
]);
export type SceneViewport = typeof SceneViewport.Type;

/**
 * The deterministic half: every layer here was computed by the server from
 * archived bars and the deterministic engines. The model cannot write these;
 * it can only cause them to exist by naming a recipe.
 */
export const DeterministicSceneLayer = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("event_span"),
    startAt: UnixMillis,
    endAt: UnixMillis,
    label: Schema.String,
    /** Which report row this span belongs to, so the graph can bind layers. */
    occurrenceIndex: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("study_entry"),
    at: UnixMillis,
    price: Schema.Number,
    occurrenceIndex: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("study_exit"),
    at: UnixMillis,
    price: Schema.Number,
    occurrenceIndex: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("return_span"),
    fromT: UnixMillis,
    toT: UnixMillis,
    returnPct: Schema.Number,
    occurrenceIndex: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("backtest_trade"),
    entryAt: UnixMillis,
    exitAt: UnixMillis,
    entryPrice: Schema.Number,
    exitPrice: Schema.Number,
    side: Schema.Literals(["long", "short"]),
    netUsd: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("line"),
    /** What the line is and where its numbers came from, in one label. */
    label: Schema.String,
    points: Schema.Array(Schema.Struct({ at: UnixMillis, value: Schema.Number })),
  }),
]);
export type DeterministicSceneLayer = typeof DeterministicSceneLayer.Type;

/**
 * The explanatory half: authored, never computed, and always rendered with
 * an authored marker beside the deterministic layers. A note is prose, a
 * label names a moment, a price line and a price zone point at levels the
 * author wants the reader to see. No coordinates, no styling, no markup:
 * where and how they draw is the graph's own decision.
 */
export const AuthoredSceneLayer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("note"), at: UnixMillis, text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("label"), at: UnixMillis, text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("price_line"), price: Schema.Number, label: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("price_zone"),
    fromPrice: Schema.Number,
    toPrice: Schema.Number,
    label: Schema.String,
  }),
]);
export type AuthoredSceneLayer = typeof AuthoredSceneLayer.Type;

/** One composed scene: what a viewport is looking at, and the layers on it. */
export const TradingChartScene = Schema.Struct({
  sceneId: Schema.String,
  kind: ResearchSceneKind,
  viewport: SceneViewport,
  deterministic: Schema.Array(DeterministicSceneLayer),
  authored: Schema.Array(AuthoredSceneLayer),
  /** Every externally dated fact the deterministic half rests on. */
  sources: Schema.Array(Schema.String),
  disclaimer: Schema.Literal(RESEARCH_DISCLAIMER),
});
export type TradingChartScene = typeof TradingChartScene.Type;

/**
 * Validate a composed scene against the caps. `null` when it may be served.
 * Pure and total so the composer's output is checked exactly like anything
 * a future caller might hand it: layers over the cap, empty or over-long
 * text, oversized payloads, and occurrence counts past the event-set cap are
 * all refused here, before anything is written or rendered.
 */
export function validateTradingChartScene(scene: TradingChartScene): string | null {
  if (scene.deterministic.length + scene.authored.length > SCENE_MAX_LAYERS) {
    return `a scene may hold at most ${SCENE_MAX_LAYERS} layers, this one holds ${scene.deterministic.length + scene.authored.length}`;
  }
  for (const layer of scene.authored) {
    const text = layer.kind === "note" || layer.kind === "label" ? layer.text : layer.label;
    const cap = layer.kind === "note" ? SCENE_MAX_TEXT_CHARS : SCENE_MAX_LABEL_CHARS;
    if (text.trim().length === 0 || text.length > cap) {
      return `an authored layer's text must be 1-${cap} characters`;
    }
  }
  const occurrences = new Set(
    scene.deterministic.flatMap((layer) =>
      layer.kind === "study_entry" || layer.kind === "study_exit" || layer.kind === "return_span"
        ? [layer.occurrenceIndex]
        : [],
    ),
  );
  if (occurrences.size > SCENE_MAX_OCCURRENCES) {
    return `a scene may reference at most ${SCENE_MAX_OCCURRENCES} occurrences`;
  }
  if (JSON.stringify(scene).length > SCENE_MAX_JSON_CHARS) {
    return `a scene must stay under ${SCENE_MAX_JSON_CHARS} characters serialized`;
  }
  return null;
}

/**
 * Compose an event-study artifact's deterministic layers, server-side and
 * pure: spans, entries, exits, and return spans straight off the report the
 * engine produced. The aggregate and baseline ride the scene as `line`
 * layers when present; occurrences without a measurement contribute their
 * span and source only, never a fabricated return. An instantaneous
 * activation contributes no event_span at all — its entry marker carries the
 * instant, and a zero-width band would claim a span that does not exist.
 */
export function composeEventStudyScene(payload: EventStudyScenePayload): TradingChartScene {
  const deterministic: Array<DeterministicSceneLayer> = [];
  const sources = new Set<string>();
  payload.report.rows.forEach((row, index) => {
    // An instantaneous activation (timePrecision "instant", start equal to
    // end) draws no zero-width event_span band: a band with no width is a
    // claim about a span that does not exist, and the study's entry marker
    // already carries the instant. Real windows — and date-precision days,
    // whose span is the whole UTC day — keep their bands; only the LABEL
    // distinguishes date precision, and that is the presenter's to say.
    const instant = row.timePrecision === "instant" && row.startAt === row.endAt;
    if (!instant) {
      deterministic.push({
        kind: "event_span",
        startAt: row.startAt,
        endAt: row.endAt,
        label: row.label ?? `occurrence ${index + 1}`,
        occurrenceIndex: index,
      });
    }
    sources.add(row.source);
    if (row.covered && row.entryTime !== undefined && row.entryPrice !== undefined) {
      deterministic.push({
        kind: "study_entry",
        at: row.entryTime,
        price: row.entryPrice,
        occurrenceIndex: index,
      });
    }
    if (row.covered && row.exitTime !== undefined && row.exitPrice !== undefined) {
      deterministic.push({
        kind: "study_exit",
        at: row.exitTime,
        price: row.exitPrice,
        occurrenceIndex: index,
      });
    }
    if (
      row.covered &&
      row.returnPct !== undefined &&
      row.entryTime !== undefined &&
      row.exitTime !== undefined
    ) {
      deterministic.push({
        kind: "return_span",
        fromT: row.entryTime,
        toT: row.exitTime,
        returnPct: row.returnPct,
        occurrenceIndex: index,
      });
    }
  });
  if (payload.report.baseline !== null) {
    deterministic.push({
      kind: "line",
      label: "baseline: every-bar mean forward return over the same horizon",
      points: [
        { at: payload.archiveBounds.fromT, value: payload.report.baseline.meanReturnPct },
        { at: payload.archiveBounds.toT, value: payload.report.baseline.meanReturnPct },
      ],
    });
  }
  return {
    sceneId: "",
    kind: "event_study",
    viewport: { kind: "event_aligned", anchorAt: payload.archiveBounds.fromT },
    deterministic,
    authored: [],
    sources: [...sources],
    disclaimer: RESEARCH_DISCLAIMER,
  };
}

export const ResearchSceneView = Schema.Struct({
  sceneId: Schema.String,
  threadId: Schema.String,
  status: ResearchSceneStatus,
  /** Whether the recipe's references still resolve: ok, retired, unknown. */
  referenceStatus: Schema.Literals(["ok", "retired", "unknown"]),
  kind: ResearchSceneKind,
  title: Schema.String,
  createdAt: UnixMillis,
  updatedAt: UnixMillis,
  calculationVersion: Schema.String,
  /** Fixed disclaimers, rendered beside the numbers, never paraphrased. */
  disclaimer: Schema.Literal(RESEARCH_DISCLAIMER),
  /** The server-composed layers and viewport the graph renders, when the kind has a composer. */
  scene: Schema.optional(TradingChartScene),
  eventStudy: Schema.optional(EventStudyScenePayload),
  strategyReplay: Schema.optional(StrategyReplayScenePayload),
  annotation: Schema.optional(AnnotationScenePayload),
});
export type ResearchSceneView = typeof ResearchSceneView.Type;

/** Compose the windows the client fetches per occurrence: bounded, measured. */
export function occurrenceWindowsForStudy(
  payload: EventStudyScenePayload,
): ReadonlyArray<ResearchOccurrenceWindow> {
  return payload.occurrenceWindows;
}

// ---------------------------------------------------------------------------
// the tool surface
// ---------------------------------------------------------------------------

export const TradingChartAction = Schema.Literals([
  "publish_event_study",
  "publish_strategy_replay",
  "annotate",
  "show",
  "list",
  "clear",
]);
export type TradingChartAction = typeof TradingChartAction.Type;

/** The thesis source for a replay: inline, or the latest version of an idea. */
export const TradingChartInput = Schema.Struct({
  /** Attribution, never authority: a scene takes no mission state. */
  missionId: Schema.optional(Schema.String),
  action: Schema.optional(TradingChartAction),
  sceneId: Schema.optional(Schema.String),
  /** Required by publish_event_study. */
  eventSetId: Schema.optional(Schema.String),
  market: Schema.optional(TradingMarket),
  interval: Schema.optional(BacktestInterval),
  horizonBars: Schema.optional(Schema.Number),
  title: Schema.optional(Schema.String),
  /** Required by publish_strategy_replay when thesis is absent. */
  thesis: Schema.optional(TradingThesis),
  hypothesisId: Schema.optional(Schema.String),
  /** Required by annotate. */
  /**
   * Optional per-notional illustration for an event study (e.g. 1000 for
   * "$1,000 after each conference"). Part of the recipe: the deterministic
   * returns are the output; this only names the multiplier the graph labels
   * its gross, feeless illustration against.
   */
  illustrativeNotionalUsd: Schema.optional(Schema.Number),
  /**
   * How the study prices its entry. Defaults to
   * {@link EVENT_STUDY_DEFAULT_ENTRY_BASIS}; the menu spells both values out.
   */
  entryBasis: Schema.optional(EventStudyEntryBasis),
  /**
   * The study metric to publish: forward_return (default) or path_extrema
   * (with `direction`, and optional `priceField`), resolved by
   * {@link resolveEventStudyMetric} exactly as the trading_events study
   * action resolves them, so a published scene is the same study the study
   * action described.
   */
  metric: Schema.optional(EventStudyMetric),
  /** path_extrema only: the side whose favorable excursion is measured. */
  direction: Schema.optional(EventStudyDirection),
  /** path_extrema only: overrides the extremum price field (low for short, high for long). */
  priceField: Schema.optional(EventStudyPriceField),
  at: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  /** clear with no sceneId clears the thread's scenes. */
});
export type TradingChartInput = typeof TradingChartInput.Type;

export const TradingChartResult = Schema.Struct({
  scene: Schema.optional(ResearchSceneView),
  scenes: Schema.optional(Schema.Array(ResearchSceneView)),
  outcome: Schema.optional(Schema.String),
  refused: Schema.optional(Schema.String),
  menu: Schema.optional(Schema.String),
});
export type TradingChartResult = typeof TradingChartResult.Type;

/**
 * The vocabulary, composed from the constants that enforce it. The tool is a
 * presentation tool: it publishes what the deterministic engines computed,
 * and it holds no exchange authority of any kind.
 */
export function renderTradingChartMenu(): string {
  return [
    "publish_event_study {eventSetId, market, interval?, horizonBars?, entryBasis?, metric?, direction?, priceField?, illustrativeNotionalUsd?, title?} measures the set on the archive " +
      `(horizon default ${EVENT_STUDY_DEFAULT_HORIZON_BARS}, entry basis ${EVENT_STUDY_DEFAULT_ENTRY_BASIS}: ${EVENT_STUDY_ENTRY_BASIS_PHRASES[EVENT_STUDY_DEFAULT_ENTRY_BASIS]}` +
      "; metric path_extrema {direction short|long} publishes the post-entry extremum (a short's lowest low) and its excursion beside the terminal return, hindsight-perfect and labelled) " +
      "and puts the study on this thread's graph: calendar windows, aligned traces, coverage and sources; publishing itself returns the scene on the graph, no follow-up show call",
    "publish_strategy_replay {thesis | hypothesisId, title?} runs one cost-aware backtest and pins its trades and verdict to the graph",
    "annotate {market, at, text} pins one authored note to a moment; it renders labelled as authored, never as a computed layer",
    `show {sceneId}; list; clear {sceneId?} (no sceneId clears this thread's scenes, at most ${RESEARCH_SCENES_MAX_PER_THREAD} scenes a thread)`,
    "scenes are research: they place no order, arm no validation, and say so beside every number",
  ].join(" · ");
}
