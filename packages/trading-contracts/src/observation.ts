/**
 * `trading_look` — the one read, plan 29 step 6.1.
 *
 * Twelve read tools used to answer twelve halves of the same question, and the
 * `TradingWakeupComposer` answered all of it again, differently, on every wake.
 * They are two implementations of "what does the model need to know"; this is
 * the contract for the surviving one, and the composer is its implementation.
 *
 * A `look` is always safe to take and always returns the same shape: the market
 * as it is now, what the mission holds, what it has already done, and one line
 * of cost context. Nothing here gates anything.
 *
 * @module TradingObservation
 */
import { Schema } from "effect";

import { AgentAccountSnapshot, AgentNetPosition, AgentOpenOrder } from "./account-snapshot.ts";
import { TradingCostContext, TradingCostEstimate } from "./costs.ts";
import { ForgeEvaluationStatus, ForgeHookFeeHundredthsBps, ForgeSwapObservation } from "./forge.ts";
import { TradingTradeHistory } from "./history.ts";
import { IndicatorReading } from "./indicators.ts";
import { MarketCandleSeries, ObservedMarketSnapshot, OrderBook, ResolvedMarket } from "./market.ts";
import {
  ObservedMarketStructure,
  StrategyCandidate,
  TimeframeAlignment,
} from "./marketStructure.ts";
import { MarketMicrostructure } from "./microstructure.ts";
// Type-only: `toForgeDetectorResultSummary` below narrows the authoritative
// `DetectionResult`. `researchEvidence.ts` imports only primitives, so this
// edge cannot cycle; the summary SCHEMA stays a bounded local mirror on
// purpose (see its comment).
import type { DetectionResult } from "./researchEvidence.ts";
import { TradingId, TradingMarket, UnixMillis } from "./primitives.ts";
import { TradingTimeframe } from "./strategy.ts";
import { DERIVED_METRIC_CATALOG } from "./watch.ts";
import { LevelHistoryEntry, PreviousStructureRead } from "./wakeup.ts";
import { ObservedVolatility } from "./volatility.ts";
import { TradingGetMissionResult } from "./tools.ts";

export const TRADING_LOOK_TOOL = "trading_look";

/**
 * The most bars a `candles:<interval>:<n>` fetch will return.
 *
 * The cap is the schema's, not the caller's: a bounded response is the point,
 * and a bound the model can raise is not a bound. Above this the answer is a
 * chart, and a chart is not something to put in a context window.
 */
export const TRADING_LOOK_MAX_BARS = 200;

/**
 * How many book levels a side a look echoes.
 *
 * Ten, because that is the depth `microstructure.bookImbalance` scores and
 * `liquidity.nearDepthUsd` sums — the readings the model is pointed at. The
 * twenty the gateway returns made the second half of the book a thing nothing
 * in the response referred to.
 */
export const TRADING_LOOK_BOOK_LEVELS = 10;

/**
 * `market` defaults to the mission's own market. A thread with no live mission
 * may still look at a market — the read is the same answer whoever asks — and
 * fetches the market-side keys; the mission-side keys refuse with a reason.
 */
export const TradingLookInput = Schema.Struct({
  missionId: Schema.optional(TradingId),
  market: Schema.optional(TradingMarket),
  /**
   * Catalog keys to fetch by name, each at its published size (plan 38 §2.1).
   *
   * Deliberately plain strings, NOT a literal union: unknown keys are refused
   * by name with the nearest valid key (§2.3 rule 4), which the handler can
   * only do when the key reaches it — an enum here would turn that refusal
   * into a generic schema-decode failure the model cannot act on. Validation
   * lives in `parseTradingLookFetchKey`; `nearestTradingLookKey` names the
   * fix. Absent or empty, the call returns the menu
   * ({@link renderTradingLookMenu}).
   */
  fetch: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The bar interval the interval-less fetch keys measure on (`volatility`,
   * `microstructure`, `indicators:<spec>`). Defaults to the mission's own.
   */
  interval: Schema.optional(TradingTimeframe),
});
export type TradingLookInput = typeof TradingLookInput.Type;

// -- the fetch catalog (plan 38 §2.2) -----------------------------------------

/** One priced entry in the `fetch` catalog. */
export interface TradingLookCatalogEntry {
  /** The key a call names — the base name, for parameterized entries. */
  readonly key: string;
  /**
   * The published size in characters. For parameterized entries this is the
   * per-unit figure: per bar, per row, per reading, per event.
   */
  readonly chars: number;
  /** The parameter shape, for keys that take one. */
  readonly parameterized?: "<interval>:<n>" | "<W>" | "<n>" | "<spec>" | "<capabilityId>";
  /** Served from the market archive, not the exchange (§2.4). */
  readonly archive?: boolean;
  readonly note?: string;
}

/**
 * Everything `trading_look({fetch:[...]})` can serve, at its published price
 * (plan 38 §2.2). Sizes are the plan's measured (m) / estimated (e) figures,
 * copied verbatim — the published price is the contract, and a key whose real
 * size drifts past it is a failing test, not a surprise.
 *
 * `cost` is not in the plan's §2.2 table but §4.2's "nothing is deleted
 * outright" invariant keeps the retired market read's 101-char cost line reachable
 * (plan §4.2).
 */
export const TRADING_LOOK_CATALOG: ReadonlyArray<TradingLookCatalogEntry> = [
  { key: "snapshot", chars: 454 },
  { key: "book", chars: 130 },
  { key: "book_full", chars: 898 },
  { key: "microstructure", chars: 599 },
  {
    key: "candles",
    chars: 38,
    parameterized: "<interval>:<n>",
    note: "indicators:<spec> is the cheaper derived alternative (~40 a reading)",
  },
  {
    key: "indicators",
    chars: 63,
    parameterized: "<spec>",
    note: "~125 for a pair; macd and bollinger carry three numbers, so nearer 110 each",
  },
  { key: "volatility", chars: 677 },
  { key: "volatility_htf", chars: 680 },
  { key: "structure", chars: 4375 },
  {
    key: "structure_brief",
    chars: 640,
    note: "alignment + the top candidate, fixture-measured (plan 38 phase 2c)",
  },
  { key: "funding_stats", chars: 140, parameterized: "<W>", archive: true },
  { key: "funding_series", chars: 52, parameterized: "<n>", archive: true },
  { key: "oi_premium", chars: 100, parameterized: "<n>", archive: true },
  { key: "book_history", chars: 89, parameterized: "<n>", archive: true },
  {
    key: "scan",
    chars: 550,
    archive: true,
    note: "cross-market CONTEXT for every archived coin, not market selection",
  },
  {
    key: "levels",
    chars: 1136,
    note: "886 of mission level history + ~250 of UTC-day anchored session levels (prior H/L/C, today O/H/L, VWAP) from archived 5m candles",
  },
  { key: "position", chars: 180 },
  { key: "position_costs", chars: 900 },
  { key: "orders", chars: 46 },
  { key: "account", chars: 248 },
  { key: "plan", chars: 1258 },
  { key: "watches", chars: 2860 },
  { key: "events", chars: 90, parameterized: "<n>", note: "~90 per event" },
  { key: "journal", chars: 1219 },
  { key: "trades", chars: 1173 },
  { key: "calibration", chars: 1047 },
  { key: "plan_history", chars: 3342 },
  {
    key: "cost",
    chars: 101,
    note: "plan §4.2 — the retired market read's cost line stays reachable",
  },
  {
    key: "forge",
    chars: 140,
    parameterized: "<capabilityId>",
    note: "installed Forge capabilities from the runtime store; forge:<id> latest, forge:<id>:history",
  },
];

/** The catalog's fixed (non-parameterized) keys, as a type. */
const TRADING_LOOK_FIXED_FETCH_BASES = [
  "snapshot",
  "book",
  "book_full",
  "microstructure",
  "volatility",
  "volatility_htf",
  "structure",
  "structure_brief",
  "scan",
  "levels",
  "position",
  "position_costs",
  "orders",
  "account",
  "plan",
  "watches",
  "journal",
  "trades",
  "calibration",
  "plan_history",
  "cost",
] as const;
export type TradingLookFixedFetchBase = (typeof TRADING_LOOK_FIXED_FETCH_BASES)[number];

/** The most rows an archive-backed series fetch will return. */
export const TRADING_LOOK_MAX_ARCHIVE_ROWS = 200;
/** The window bound on `funding_stats:<W>`, in days. */
export const TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS = 30;
/** The bound on `events:<n>` — the pending-event tail is short by nature. */
export const TRADING_LOOK_MAX_EVENTS = 20;
/** What a bare `events` key serves: the recent tail, uncapped by the caller. */
export const TRADING_LOOK_DEFAULT_EVENTS = 5;

/**
 * The candle intervals a `candles:<interval>:<n>` fetch accepts. Live look
 * stops at 1h — coarser history is the event study's job, not the look's
 * (the two grammars deliberately differ). Exported so the menu and the tests
 * quote the parser's own set.
 */
export const TRADING_LOOK_INTERVALS: ReadonlyArray<TradingTimeframe> = [
  "1m",
  "3m",
  "5m",
  "15m",
  "1h",
];

/**
 * The menu the catalog call returns — `trading_look` with no `fetch` and no
 * (plan 38 §2.3 rule 3). `key=chars` entries, the four archive keys
 * starred, and one legend clause. No descriptions, no prose beyond the legend:
 * the model budgets its own context off this blob (rule 1). Parameterized
 * entries carry their parser-enforced bounds inline, so the one catalog call
 * is also the only call needed to compose a legal key.
 */
export function renderTradingLookMenu(): string {
  const entries = TRADING_LOOK_CATALOG.map((entry) => {
    const suffix = entry.parameterized === undefined ? "" : paramSuffix(entry.key);
    const star = entry.archive === true ? "*" : "";
    return `${entry.key}${suffix}=${entry.chars}${entry.parameterized === undefined ? "" : "/u"}${star}`;
  });
  // The derived-metric catalog (plan 38 §3.3), one line per metric: name,
  // params, source, cadence. This and the watch refusals are where the model
  // meets the thirteen metrics — the tool descriptions never enumerate them
  // (§4.1). Rendered from `DERIVED_METRIC_CATALOG` so the menu and the
  // refusal details quote one list.
  const derived = DERIVED_METRIC_CATALOG.map(
    (metric) => `derived:${metric.metric} ${metric.params} · ${metric.source} · ${metric.cadence}`,
  );
  return (
    `${entries.join(" ")} — *archive: unavailable+reason, not data; candles: indicators is ` +
    `cheaper; scan: cross-market context, never market selection; ${derived.join(" ")}`
  );
}

/**
 * The rendered form of a parameterized key's parameter part, with the bound
 * the parser enforces. Composed from the same constants
 * `parseTradingLookFetchKey` refuses by, so the menu, the refusals, and the
 * parser can never quote different numbers.
 */
function paramSuffix(key: string): string {
  const entry = TRADING_LOOK_CATALOG.find((candidate) => candidate.key === key);
  switch (entry?.parameterized) {
    case "<interval>:<n>":
      return `:tf:n[${TRADING_LOOK_INTERVALS.join("|")};n≤${TRADING_LOOK_MAX_BARS}]`;
    case "<W>":
      return `:W[days 1-${TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS}]`;
    case "<spec>":
      return ":spec";
    case "<capabilityId>":
      return ":id[:history]";
    default:
      return `:n[1-${key === "events" ? TRADING_LOOK_MAX_EVENTS : TRADING_LOOK_MAX_ARCHIVE_ROWS}]`;
  }
}

/**
 * What `parseTradingLookFetchKey` decided a fetch key means. Invalid
 * parameters carry the named bound so the handler can refuse with the cap in
 * the refusal (§2.3 rule 5), not truncate; unknown keys carry the raw key so
 * the refusal can name the nearest valid one (rule 4).
 */
export type TradingLookFetchParse =
  | { readonly base: "candles"; readonly interval: TradingTimeframe; readonly n: number }
  | { readonly base: "indicators"; readonly spec: string }
  | { readonly base: "funding_stats"; readonly windowDays: number }
  | { readonly base: "funding_series"; readonly n: number }
  | { readonly base: "oi_premium"; readonly n: number }
  | { readonly base: "book_history"; readonly n: number }
  | { readonly base: "events"; readonly n: number; readonly explicit: boolean }
  | { readonly base: "forge"; readonly selection: "catalog" }
  | {
      readonly base: "forge";
      readonly capabilityId: string;
      readonly selection: "latest" | "history";
    }
  | { readonly base: TradingLookFixedFetchBase }
  | { readonly base: "invalid_params"; readonly key: string; readonly bound: string }
  | { readonly base: "unknown"; readonly key: string };

/**
 * Parse one `fetch` key into its served meaning. Parameter bounds live here —
 * not in the schema — so the refusal can name the bound.
 */
export function parseTradingLookFetchKey(key: string): TradingLookFetchParse {
  const fixed = TRADING_LOOK_FIXED_FETCH_BASES.find((candidate) => candidate === key);
  if (fixed !== undefined) return { base: fixed };

  const parts = key.split(":");
  const [base, ...params] = parts;
  const n = () => {
    const parsed = Number(params[0]);
    return Number.isInteger(parsed) ? parsed : Number.NaN;
  };

  if (base === "candles") {
    const interval = params[0];
    const bars = Number(params[1]);
    if (!TRADING_LOOK_INTERVALS.includes(interval as TradingTimeframe)) {
      return {
        base: "invalid_params",
        key,
        bound: `interval must be one of ${TRADING_LOOK_INTERVALS.join(",")}`,
      };
    }
    if (!Number.isInteger(bars) || bars < 0 || bars > TRADING_LOOK_MAX_BARS) {
      return { base: "invalid_params", key, bound: `n must be 0..${TRADING_LOOK_MAX_BARS}` };
    }
    return { base: "candles", interval: interval as TradingTimeframe, n: bars };
  }
  if (base === "indicators") {
    if (params.length !== 1 || params[0] === "") {
      return { base: "invalid_params", key, bound: "spec is required" };
    }
    return { base: "indicators", spec: params[0] as string };
  }
  if (base === "events") {
    if (params.length === 0)
      return { base: "events", n: TRADING_LOOK_DEFAULT_EVENTS, explicit: false };
    const rows = n();
    if (!Number.isInteger(rows) || rows < 1 || rows > TRADING_LOOK_MAX_EVENTS) {
      return { base: "invalid_params", key, bound: `n must be 1..${TRADING_LOOK_MAX_EVENTS}` };
    }
    return { base: "events", n: rows, explicit: true };
  }
  if (base === "funding_stats") {
    const days = Number(params[0]);
    if (!Number.isInteger(days) || days < 1 || days > TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS) {
      return {
        base: "invalid_params",
        key,
        bound: `W must be 1..${TRADING_LOOK_MAX_FUNDING_WINDOW_DAYS}`,
      };
    }
    return { base: "funding_stats", windowDays: days };
  }
  if (base === "forge") {
    // The capability id grammar the store keys by. Which ids EXIST is the
    // store's answer at runtime — the parser only holds the shape, so an
    // installed-later capability needs no parser change.
    if (params.length === 0) return { base: "forge", selection: "catalog" };
    const capabilityId = params[0] ?? "";
    if (!FORGE_CAPABILITY_ID_PATTERN.test(capabilityId)) {
      return {
        base: "invalid_params",
        key,
        bound: "capabilityId must match [a-z0-9][a-z0-9-]{0,63}",
      };
    }
    const tail = params.slice(1);
    if (tail.length === 0) return { base: "forge", capabilityId, selection: "latest" };
    if (tail.length === 1 && tail[0] === "history")
      return { base: "forge", capabilityId, selection: "history" };
    return {
      base: "invalid_params",
      key,
      bound: "the only suffixes are forge:<capabilityId> and forge:<capabilityId>:history",
    };
  }
  for (const seriesBase of ["funding_series", "oi_premium", "book_history"] as const) {
    if (base !== seriesBase) continue;
    const rows = n();
    if (!Number.isInteger(rows) || rows < 1 || rows > TRADING_LOOK_MAX_ARCHIVE_ROWS) {
      return {
        base: "invalid_params",
        key,
        bound: `n must be 1..${TRADING_LOOK_MAX_ARCHIVE_ROWS}`,
      };
    }
    return { base: seriesBase, n: rows };
  }

  return { base: "unknown", key };
}

/**
 * The nearest valid catalog key by edit distance, ties broken by catalog
 * order. Parameterized entries match on their base name — the caller gets
 * `candles` back and supplies `<interval>:<n>` itself.
 */
export function nearestTradingLookKey(key: string): string {
  const target = key.split(":")[0] ?? key;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of TRADING_LOOK_CATALOG) {
    const distance = levenshtein(target, entry.key);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry.key;
    }
  }
  return best ?? key;
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from<number>({ length: b.length + 1 });
  const current = Array.from<number>({ length: b.length + 1 });
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]!;
  }
  return previous[b.length]!;
}

// -- the Forge capability lifecycle (T3-14 / F2) -------------------------------
//
// The host's seal over a capability an in-app agent authored: what was asked,
// which stages ran, which exact bytes were tested, and what became installed.
// The agent writes four artifacts in its own workspace; the HOST compiles,
// tests, accepts, hashes and installs. Nothing here can be satisfied by a
// model printing "pass" — every field is a host-computed fact.

/** The `trading_forge` lifecycle tool. */
export const TRADING_FORGE_TOOL = "trading_forge";

/**
 * A capability id: the stable name a bundle is keyed by and the parameter a
 * `forge:<capabilityId>` fetch key names. Lowercase, hyphen-separated, bounded
 * so it is always a filename-safe path segment.
 */
export const FORGE_CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The four artifacts a Forge capability is, exactly — no more, no fewer. */
export const FORGE_CAPABILITY_ARTIFACT_PATHS = [
  "query.graphql",
  "signal.ts",
  "signal.test.ts",
  "manifest.json",
] as const;
export type ForgeCapabilityArtifactPath = (typeof FORGE_CAPABILITY_ARTIFACT_PATHS)[number];

/** Total size of the four artifacts together: 256 KiB. */
export const FORGE_MAX_BUNDLE_BYTES = 256 * 1024;

/** Sandbox stdin (JSON input) cap: 2 MiB. */
export const FORGE_SANDBOX_MAX_INPUT_BYTES = 2 * 1024 * 1024;

/** Sandbox stdout and stderr cap, each: 64 KiB — overflow kills the run. */
export const FORGE_SANDBOX_MAX_OUTPUT_BYTES = 64 * 1024;

/** Build/check containment budget (~30s). */
export const FORGE_SANDBOX_BUILD_BUDGET_MS = 30_000;

/** Evaluation containment budget (~2s). */
export const FORGE_SANDBOX_EVALUATION_BUDGET_MS = 2_000;

/** The manifest schema version the F2 SDK and host agree on. */
export const FORGE_SDK_SCHEMA_VERSION = 1;

/** The bounded semantics a build request may carry, in characters. */
export const FORGE_MAX_SEMANTICS_CHARS = 4_000;

/** How many staged bundles and builds a listing read returns at most. */
export const FORGE_MAX_LISTED_ITEMS = 50;

/** How many observations an `inspect_sources` sample returns at most. */
export const FORGE_MAX_SOURCE_SAMPLE = 20;

/**
 * The build lifecycle a host walks an authoring request through. The happy
 * path is `requested → inspecting → authoring → checking → ready → installed`;
 * `failed` and `cancelled` are terminal from anywhere.
 */
export const ForgeCapabilityBuildStage = Schema.Literals([
  "requested",
  "inspecting",
  "authoring",
  "checking",
  "ready",
  "installed",
  "failed",
  "cancelled",
]);
export type ForgeCapabilityBuildStage = typeof ForgeCapabilityBuildStage.Type;

/** One timestamped stage transition the host recorded — the receipt trail. */
export const ForgeBuildStageReceipt = Schema.Struct({
  stage: ForgeCapabilityBuildStage,
  atMs: UnixMillis,
  detail: Schema.optional(Schema.String),
});
export type ForgeBuildStageReceipt = typeof ForgeBuildStageReceipt.Type;

/**
 * `manifest.json` — artifact four. The provider authors it; the host validates
 * it. `schemaVersion` must equal {@link FORGE_SDK_SCHEMA_VERSION} exactly, so
 * a bundle written against a different SDK generation cannot install silently.
 */
export const ForgeCapabilityManifest = Schema.Struct({
  capabilityId: Schema.String.check(Schema.isPattern(FORGE_CAPABILITY_ID_PATTERN)),
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  schemaVersion: Schema.Int,
  /** The semantics as the provider understood them, restated in its own words. */
  description: Schema.String,
}).check(
  Schema.makeFilter((input) => {
    if (input.schemaVersion !== FORGE_SDK_SCHEMA_VERSION) {
      return `manifest schemaVersion must be ${FORGE_SDK_SCHEMA_VERSION}`;
    }
    if (input.description.length > 0 && input.description.length <= FORGE_MAX_SEMANTICS_CHARS) {
      return true;
    }
    return "manifest description must be 1..4000 characters";
  }),
);
export type ForgeCapabilityManifest = typeof ForgeCapabilityManifest.Type;

/** Source provenance as the typed SDK carries it — the frozen F0 contract. */
export const ForgeSourceEvidence = Schema.Struct({
  mode: Schema.Literals(["live", "historical"]),
  provider: Schema.Literals(["the-graph"]),
  deploymentId: Schema.String.check(Schema.isNonEmpty()),
  blockNumber: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  blockHash: Schema.String.check(Schema.isNonEmpty()),
  fetchedAtMs: UnixMillis,
  windowEndMs: UnixMillis,
  querySha256: Schema.String.check(Schema.isNonEmpty()),
  responseSha256: Schema.String.check(Schema.isNonEmpty()),
  complete: Schema.Boolean,
});
export type ForgeSourceEvidence = typeof ForgeSourceEvidence.Type;

/**
 * One pool's window, aggregated by the HOST from normalized observations:
 * exact move in bps, stable-quote volume in micro-units, trade count, and the
 * provenance ids every diagnostic must reference. Classification is the
 * capability's job; aggregation is never the model's.
 */
export const ForgePoolWindow = Schema.Struct({
  poolId: Schema.String.check(Schema.isNonEmpty()),
  /** Window price move vs the anchor, integer basis points. */
  moveBps: Schema.NullOr(Schema.Int),
  /** Absolute USDC volume over the window, integer micro-units, decimal string. */
  quoteVolumeMicros: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  tradeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Every source trade id in the window — diagnostics reference a subset. */
  observationIds: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
  /** Raw normalized swaps allow revised detectors to filter trades themselves. */
  observations: Schema.optional(Schema.Array(ForgeSwapObservation)),
  anchorCandidates: Schema.optional(Schema.Array(ForgeSwapObservation)),
  /** The resolved pre-window anchor, when the anchor buffer held one. */
  anchor: Schema.optional(
    Schema.Struct({
      observationId: Schema.String.check(Schema.isNonEmpty()),
      priceQuotePerBaseMicros: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
      ageBeforeWindowSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
export type ForgePoolWindow = typeof ForgePoolWindow.Type;

/** What a capability is fed: one sealed window's evidence and pool aggregates. */
export const ForgeSignalInput = Schema.Struct({
  evidence: ForgeSourceEvidence,
  pools: Schema.Array(ForgePoolWindow),
});
export type ForgeSignalInput = typeof ForgeSignalInput.Type;

/**
 * The reading a capability emits — the SDK's output contract, frozen. The
 * regime labels are the contract's, not any one detector's semantics: a
 * capability maps pools onto them however its authored logic decides.
 */
export const ForgeSignalRegime = Schema.Literals(["coordinated", "isolated", "quiet"]);
export type ForgeSignalRegime = typeof ForgeSignalRegime.Type;

export const ForgeSignalReading = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["ready"]),
    regime: ForgeSignalRegime,
    /** Fraction of eligible pools in agreement, 0..1. */
    agreement: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
    eligiblePoolIds: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
  }),
  Schema.Struct({
    kind: Schema.Literals(["insufficient"]),
    reason: Schema.String.check(Schema.isNonEmpty()),
  }),
]);
export type ForgeSignalReading = typeof ForgeSignalReading.Type;

/**
 * Per-pool diagnostics a capability must report beside its reading: which
 * trades qualified, which were excluded, the volume it counted, and the anchor
 * it used. The host validates the references against the input window — a
 * diagnostic naming a trade the window never held is a failed check, not prose.
 */
export const ForgePoolDiagnostics = Schema.Struct({
  poolId: Schema.String.check(Schema.isNonEmpty()),
  qualifyingCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  excludedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  quoteVolumeMicros: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  anchorObservationId: Schema.optional(Schema.String),
  tradeIds: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
});
export type ForgePoolDiagnostics = typeof ForgePoolDiagnostics.Type;

/** The capability entrypoint's full output: the reading plus its diagnostics. */
export const ForgeSignalOutput = Schema.Struct({
  reading: ForgeSignalReading,
  diagnostics: Schema.Array(ForgePoolDiagnostics),
});
export type ForgeSignalOutput = typeof ForgeSignalOutput.Type;

/**
 * One host-owned acceptance case: an input window and the reading the requester
 * expects. Data, not code — the builder stays generic, and the eth-coordination
 * expectations travel in the demo's request, never in host source.
 */
export const ForgeAcceptanceCase = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  input: ForgeSignalInput,
  expected: ForgeSignalReading,
});
export type ForgeAcceptanceCase = typeof ForgeAcceptanceCase.Type;

/** One named containment check's host-computed outcome. */
export const ForgeCheckOutcome = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  passed: Schema.Boolean,
  /** The container's exit code, or null when the run was killed. */
  exitCode: Schema.optional(Schema.Int),
  detail: Schema.optional(Schema.String),
});
export type ForgeCheckOutcome = typeof ForgeCheckOutcome.Type;

/**
 * The sealed build receipt: the host's record of one authoring request from
 * `requested` to a terminal stage. Every array is append-only history; the
 * `stage` field is the current position.
 */
export const ForgeBuildReceipt = Schema.Struct({
  buildId: Schema.String.check(Schema.isNonEmpty()),
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  threadId: Schema.optional(Schema.String),
  capabilityId: Schema.optional(Schema.String),
  /** The user's semantics, as the request carried them. */
  requestedSemantics: Schema.String,
  stage: ForgeCapabilityBuildStage,
  stages: Schema.Array(ForgeBuildStageReceipt),
  /** Typecheck, generated tests, acceptance, determinism — host-run, in containment. */
  checks: Schema.optional(Schema.Array(ForgeCheckOutcome)),
  acceptance: Schema.optional(
    Schema.Struct({
      total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      passed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      failed: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
    }),
  ),
  /** Per-artifact hashes, host-computed over the exact tested bytes. */
  artifactSha256: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  ),
  /** Hash over the canonical bundle — the identity `install` pins. */
  bundleSha256: Schema.optional(Schema.String),
  /** Present on `failed`; never a success detail. */
  failureReason: Schema.optional(Schema.String),
  createdAtMs: UnixMillis,
  updatedAtMs: UnixMillis,
});
export type ForgeBuildReceipt = typeof ForgeBuildReceipt.Type;

/**
 * One immutable capability version: the exact bytes, their hashes, and the
 * validated manifest. A version, once written, can never change content —
 * only its installation status moves.
 */
export const ForgeCapabilityVersion = Schema.Struct({
  capabilityId: Schema.String.check(Schema.isPattern(FORGE_CAPABILITY_ID_PATTERN)),
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  bundleSha256: Schema.String.check(Schema.isNonEmpty()),
  artifacts: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.String.check(Schema.isNonEmpty()),
      bytes: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
  manifest: ForgeCapabilityManifest,
  createdAtMs: UnixMillis,
});
export type ForgeCapabilityVersion = typeof ForgeCapabilityVersion.Type;

/** An installed capability's lifecycle status, as the catalog reports it. */
export const ForgeCapabilityStatus = Schema.Literals(["installed", "paused", "uninstalled"]);
export type ForgeCapabilityStatus = typeof ForgeCapabilityStatus.Type;

/** One catalog entry: what `forge` discovery serves, from the store at runtime. */
export const ForgeCapabilityCatalogEntry = Schema.Struct({
  capabilityId: Schema.String.check(Schema.isPattern(FORGE_CAPABILITY_ID_PATTERN)),
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  bundleSha256: Schema.String.check(Schema.isNonEmpty()),
  description: Schema.String,
  status: ForgeCapabilityStatus,
  installedAtMs: UnixMillis,
});
export type ForgeCapabilityCatalogEntry = typeof ForgeCapabilityCatalogEntry.Type;

/**
 * One sealed evaluation of an installed capability version over a pinned
 * source window — the host's record, with the reading's provenance and the
 * per-pool diagnostics the capability emitted. `status` is the
 * observed-data status; the provider job that caused it is tracked separately.
 */
export const ForgeEvaluationEvidence = Schema.Struct({
  evaluationId: Schema.String.check(Schema.isNonEmpty()),
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  threadId: Schema.optional(Schema.String),
  capabilityId: Schema.String.check(Schema.isNonEmpty()),
  capabilityVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  bundleSha256: Schema.String.check(Schema.isNonEmpty()),
  window: Schema.Struct({ startedAt: UnixMillis, endedAt: UnixMillis }),
  historical: Schema.Boolean,
  pinnedBlock: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  sourceDigest: Schema.optional(Schema.String),
  evidenceIds: Schema.Array(Schema.String),
  status: ForgeEvaluationStatus,
  reading: Schema.optional(ForgeSignalReading),
  diagnostics: Schema.optional(Schema.Array(ForgePoolDiagnostics)),
  failureReason: Schema.optional(Schema.String),
  createdAtMs: UnixMillis,
  completedAtMs: Schema.optional(UnixMillis),
});
export type ForgeEvaluationEvidence = typeof ForgeEvaluationEvidence.Type;

/** A pool proposed for approval — approval is a human act, never the agent's. */
export const ForgePoolProposalStatus = Schema.Literals(["proposed", "approved", "rejected"]);
export type ForgePoolProposalStatus = typeof ForgePoolProposalStatus.Type;

export const ForgePoolProposal = Schema.Struct({
  proposalId: Schema.String.check(Schema.isNonEmpty()),
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  poolId: Schema.String.check(Schema.isNonEmpty()),
  /** The thread whose conversation proposed it; absent when env-scoped. */
  proposedByThreadId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  status: ForgePoolProposalStatus,
  proposedAtMs: UnixMillis,
  decidedAtMs: Schema.optional(UnixMillis),
});
export type ForgePoolProposal = typeof ForgePoolProposal.Type;

/**
 * A policy binding record. F2 records draft bindings only — no on-chain
 * action, no signing; F3's publication path starts from these records.
 */
export const ForgePolicyBindingStatus = Schema.Literals(["draft", "revoked"]);
export type ForgePolicyBindingStatus = typeof ForgePolicyBindingStatus.Type;

export const ForgePolicyBinding = Schema.Struct({
  policyId: Schema.String.check(Schema.isNonEmpty()),
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  capabilityId: Schema.String.check(Schema.isNonEmpty()),
  capabilityVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  bundleSha256: Schema.String.check(Schema.isNonEmpty()),
  poolId: Schema.String.check(Schema.isNonEmpty()),
  detectionFeeHundredthsBps: ForgeHookFeeHundredthsBps,
  status: ForgePolicyBindingStatus,
  sourceEvaluationId: Schema.optional(Schema.String),
  createdAtMs: UnixMillis,
  revokedAtMs: Schema.optional(UnixMillis),
});
export type ForgePolicyBinding = typeof ForgePolicyBinding.Type;

// -- the trading_forge tool ----------------------------------------------------

/** Every `trading_forge` action. */
export const TradingForgeAction = Schema.Literals([
  "inspect_sources",
  "prepare",
  "check",
  "install",
  "revise",
  "status",
  "cancel",
  "pause",
  "resume",
  "uninstall",
  "arm",
  "disarm",
  "evaluate",
  "propose_pool",
  "approve_pool",
  "bind_policy",
  "revoke_policy",
  // P5.4 execution actions (additive; old payloads decode unchanged).
  "quote",
  "propose_envelope",
  "approve_envelope",
  "envelope",
  "evaluate_policy",
  "swap",
  // The protected mainnet lane's only agent-reachable step: atomic admission
  // (reserve + immutable intent). Signing/broadcast is never agent-reachable.
  "protected_swap",
  // Generated external-source adapters: declare an installed capability's
  // transform as an http-document source (spec JSON, host allowlist enforced
  // by the host), then capture it once — fetch, sandbox parse, schema
  // validation, revisions with provenance.
  "declare_source",
  "capture_source",
]);
export type TradingForgeAction = typeof TradingForgeAction.Type;

export const TradingForgeInput = Schema.Struct({
  missionId: Schema.optional(TradingId),
  action: TradingForgeAction,
  /** The capability this call is about, for the actions that name one. */
  capabilityId: Schema.optional(Schema.String.check(Schema.isPattern(FORGE_CAPABILITY_ID_PATTERN))),
  buildId: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * The optimistic lock on installation: the active version the caller read.
   * A stale value refuses rather than overwrites.
   */
  expectedActiveVersion: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /** The user's semantics for `prepare`/`revise`, in their words. */
  requestedSemantics: Schema.optional(Schema.String),
  /**
   * `prepare`: which authoring generation the brief targets. 2 selects the
   * detector-program / source-adapter contract (SDK sha256, v2 manifest,
   * declared artifact roles); absent stays the v1 four-artifact contract.
   */
  manifestVersion: Schema.optional(Schema.Literals([1, 2])),

  poolId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  reason: Schema.optional(Schema.String),
  policyId: Schema.optional(Schema.String),
  /** `bind_policy`: the detection fee the draft binding records. */
  detectionFeeHundredthsBps: Schema.optional(ForgeHookFeeHundredthsBps),

  // P5.4 execution actions (additive; all optional, old payloads decode
  // unchanged).
  /** `quote`: the approved route to price an exact-input swap over. */
  routeId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /** `quote`: the exact input amount, raw units, decimal integer string. */
  amountInRaw: Schema.optional(Schema.String),
  /** `quote`: slippage allowance applied to the quoted output, bps. */
  maxSlippageBps: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * `propose_envelope`: the ExecutionEnvelope JSON. Carried as unknown and
   * decoded server-side against the authoritative executionPolicy schema —
   * observation.ts cannot import that module (it already imports this one
   * for FORGE_CAPABILITY_ID_PATTERN), and the local-mirror alternative would
   * duplicate the whole envelope contract on the wire boundary.
   */
  envelope: Schema.optional(Schema.Unknown),
  /** `envelope`/`swap`: one execution envelope by its content id. */
  envelopeId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /** `swap`: the persisted proposal the prepared transaction executes. */
  proposalId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /**
   * `swap`: the SwapQuoteRecord JSON the caller priced. Unknown for the same
   * cycle reason as `envelope`; decoded server-side, refused by name on
   * malformed input.
   */
  quote: Schema.optional(Schema.Unknown),
  /** `protected_swap`: the execute(deadline) value, integer unix seconds. */
  deadlineUnix: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /** `declare_source`: the ExternalAdapterSourceSpec JSON (unknown-carried). */
  sourceSpec: Schema.optional(Schema.Unknown),
  /** `capture_source`/`declare_source`: the installed source's id. */
  sourceId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});
export type TradingForgeInput = typeof TradingForgeInput.Type;

/** One Forge source as `inspect_sources` reports it. */
export const ForgeSourceInspection = Schema.Struct({
  poolId: Schema.String.check(Schema.isNonEmpty()),
  label: Schema.String,
  feeTierHundredthsBps: Schema.Int,
  /** The source's own health verdict, never fabricated. */
  healthStatus: Schema.Literals(["healthy", "stale", "unavailable"]),
  healthReason: Schema.optional(Schema.String),
});
export type ForgeSourceInspection = typeof ForgeSourceInspection.Type;

/**
 * A bounded summary of one committed detector-program (v2) result.
 *
 * A deliberate MINIMAL MIRROR of `researchEvidence.ts`'s `DetectionResult`
 * three shapes, not a reuse of that schema: the full result carries
 * fact/evidence arrays the look payload must not bloat with, and the mirror
 * keeps this module's dependency surface unchanged (the mapper below takes
 * the authoritative type; the schema stays local). The authoritative
 * vocabulary is the record's own `DetectionResult`; keep the three statuses
 * and their meaning in sync with it — `matched` carries the occurrence
 * identity and how long the match stands, the other two carry the program's
 * own "why".
 */
export const ForgeDetectorResultSummary = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("matched"),
    occurrenceKey: TradingId,
    validUntilMs: UnixMillis,
  }),
  Schema.Struct({
    status: Schema.Literal("not-matched"),
    explanation: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
    explanation: Schema.String,
  }),
]);
export type ForgeDetectorResultSummary = typeof ForgeDetectorResultSummary.Type;

/**
 * Bound one committed {@link DetectionResult} into the look/tool summary.
 * The only producer-side mapping: server surfaces (the forge tool status and
 * the web bridge) both render through this so the bounded fields can never
 * drift between the two.
 */
export function toForgeDetectorResultSummary(result: DetectionResult): ForgeDetectorResultSummary {
  return result.status === "matched"
    ? { status: "matched", occurrenceKey: result.occurrenceKey, validUntilMs: result.validUntilMs }
    : result.status === "not-matched"
      ? { status: "not-matched", explanation: result.explanation }
      : { status: "unknown", explanation: result.explanation };
}

// -- P5.4 execution views (local mirrors; see the note on ForgeExecutionQuote) --

/**
 * The v3 identity field names the quote mirror carries beside the
 * authoritative `SwapQuoteRecord` (see the mirror note below). One list, so
 * the observation.test.ts drift guard can pin it without importing the
 * authoritative module (the cycle rule below explains why).
 */
export const FORGE_EXECUTION_QUOTE_V3_FIELDS = {
  routeConfigDigest: Schema.optional(Schema.String),
  quotedBlockNumber: Schema.optional(Schema.String),
  quotedBlockHash: Schema.optional(Schema.String),
  quotedAmountOutRaw: Schema.optional(Schema.String),
  quoterCodeHash: Schema.optional(Schema.String),
  targetCodeHash: Schema.optional(Schema.String),
  gasUnitsMeasured: Schema.optional(Schema.String),
  maxFeePerGasWei: Schema.optional(Schema.String),
  maxPriorityFeePerGasWei: Schema.optional(Schema.String),
} as const;

/**
 * A bounded mirror of the executionPolicy module's `SwapQuoteRecord` for the
 * tool result. Deliberately NOT an import: `executionPolicy.ts` already
 * imports this module (FORGE_CAPABILITY_ID_PATTERN), and a top-level schema
 * cycle between the two would evaluate against an uninitialized binding. The
 * authoritative contract is the one the server decodes against; keep the
 * fields and their meanings in sync with it (the DetectorResultForPolicy
 * precedent).
 */
export const ForgeExecutionQuote = Schema.Struct({
  quoteId: Schema.String.check(Schema.isNonEmpty()),
  chainId: Schema.String,
  routeId: Schema.String.check(Schema.isNonEmpty()),
  tokenIn: Schema.String,
  tokenOut: Schema.String,
  amountInRaw: Schema.String,
  minAmountOutRaw: Schema.String,
  gasEstimateWei: Schema.String,
  quotedAtMs: UnixMillis,
  expiresAtMs: UnixMillis,
  basis: Schema.Literals(["eth_call"]),
  // v3 identity fields (optional for compatibility with retained v2-era
  // rows): included in the quote id's digest when present, so admission can
  // recompute identity against the CURRENT route registry.
  ...FORGE_EXECUTION_QUOTE_V3_FIELDS,
});
export type ForgeExecutionQuote = typeof ForgeExecutionQuote.Type;

/** One envelope candidate as the `envelope` view reports it. */
export const ForgeExecutionCandidateView = Schema.Struct({
  candidateId: Schema.String.check(Schema.isNonEmpty()),
  chainId: Schema.String,
  tokenIn: Schema.String,
  tokenOut: Schema.String,
  recipient: Schema.String,
});
export type ForgeExecutionCandidateView = typeof ForgeExecutionCandidateView.Type;

/**
 * The `envelope` action's grant view: identity, lifecycle status, the
 * approval origin (the direct user path, never an agent), the caps, and the
 * host-computed remaining spend. `expired` is a derived label the store
 * serves like `ExecutionEnvelopeStatus` does.
 */
export const ForgeExecutionEnvelopeView = Schema.Struct({
  envelopeId: Schema.String.check(Schema.isNonEmpty()),
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  capabilityId: Schema.optional(Schema.String),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  status: Schema.Literals(["draft", "proposed", "approved", "revoked", "expired"]),
  expiresAtMs: UnixMillis,
  approvedVia: Schema.optional(Schema.String),
  candidates: Schema.Array(ForgeExecutionCandidateView),
  inputCapTotalRaw: Schema.String,
  inputCapPerSwapRaw: Schema.String,
  remainingInputCapRaw: Schema.String,
});
export type ForgeExecutionEnvelopeView = typeof ForgeExecutionEnvelopeView.Type;

/** One persisted proposal as the `envelope` view reports it. */
export const ForgeExecutionProposalView = Schema.Struct({
  proposalId: Schema.String.check(Schema.isNonEmpty()),
  kind: Schema.Literals(["wait", "price", "swap", "stop-future-actions", "complete"]),
  status: Schema.Literals(["proposed", "rejected", "executing", "executed", "superseded"]),
  stageKey: Schema.optional(Schema.String),
  amountInRaw: Schema.optional(Schema.String),
  proposedAtMs: UnixMillis,
});
export type ForgeExecutionProposalView = typeof ForgeExecutionProposalView.Type;

/**
 * One swap intent as the surfaces report it: what was prepared, and — when
 * submission was refused — why, verbatim. The prepared transaction bytes stay
 * server-side; this view carries their identity fields only.
 */
export const ForgeSwapIntentView = Schema.Struct({
  intentId: Schema.String.check(Schema.isNonEmpty()),
  proposalId: Schema.String.check(Schema.isNonEmpty()),
  quoteId: Schema.String.check(Schema.isNonEmpty()),
  routeId: Schema.String.check(Schema.isNonEmpty()),
  tokenIn: Schema.String,
  tokenOut: Schema.String,
  amountInRaw: Schema.String,
  minAmountOutRaw: Schema.String,
  status: Schema.Literals([
    "prepared",
    "submit-refused",
    "submitted",
    "confirmed",
    "reverted",
    "unknown",
  ]),
  preparedAtMs: UnixMillis,
  attemptAtMs: Schema.optional(UnixMillis),
  refusalReason: Schema.optional(Schema.String),
});
export type ForgeSwapIntentView = typeof ForgeSwapIntentView.Type;

/** The `evaluate_policy` outcome as the tool reports it. */
export const ForgePolicyEvaluationView = Schema.Struct({
  status: Schema.Literals(["proposed", "already-proposed", "no-proposal", "refused"]),
  proposalId: Schema.optional(Schema.String),
  proposalKind: Schema.optional(
    Schema.Literals(["wait", "price", "swap", "stop-future-actions", "complete"]),
  ),
  stageKey: Schema.optional(Schema.String),
  amountInRaw: Schema.optional(Schema.String),
  /** `no-proposal`: why the policy proposed nothing. */
  reason: Schema.optional(Schema.String),
  refusal: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});
export type ForgePolicyEvaluationView = typeof ForgePolicyEvaluationView.Type;

export const TradingForgeResult = Schema.Struct({
  outcome: Schema.Literals(["accepted", "rejected"]),
  action: TradingForgeAction,
  reason: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  buildId: Schema.optional(Schema.String),
  /**
   * `inspect_sources`: the pools and a bounded sample of REAL series points
   * from the first approved pool — real trades with their provenance ids,
   * never reconstructed or fabricated swap records.
   */
  sources: Schema.optional(
    Schema.Struct({
      inspections: Schema.Array(ForgeSourceInspection),
      sample: Schema.Array(
        Schema.Struct({
          observationId: Schema.String.check(Schema.isNonEmpty()),
          t: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          priceQuotePerBaseMicros: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
          quoteVolumeMicros: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      ),
    }),
  ),
  /** `prepare`: the authoring brief the calling agent works from. */
  brief: Schema.optional(
    Schema.Struct({
      schemaVersion: Schema.Int,
      /** The typed SDK contract the artifacts import. */
      sdkSource: Schema.String,
      /** The observation data schema, rendered. */
      dataSchema: Schema.String,
      /** Where in the calling workspace the four artifacts must land. */
      stagingDir: Schema.String,
    }),
  ),
  build: Schema.optional(ForgeBuildReceipt),
  capability: Schema.optional(ForgeCapabilityVersion),
  catalog: Schema.optional(Schema.Array(ForgeCapabilityCatalogEntry)),
  evaluation: Schema.optional(ForgeEvaluationEvidence),
  /** `status`: provider job records, kept apart from observed-data status. */
  jobs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        jobId: Schema.String,
        kind: Schema.String,
        status: Schema.String,
        detail: Schema.optional(Schema.String),
      }),
    ),
  ),
  dataStatus: Schema.optional(
    Schema.Struct({
      lastEvaluation: Schema.optional(ForgeEvaluationEvidence),
    }),
  ),
  /**
   * `status`/`arm`/`disarm`/`evaluate`, for the actions that name a
   * capability: the detector standing of the active version, plus — for a
   * detector-program v2 capability — its committed run view from the
   * detector run store. `unavailable` names why the v2 view is absent
   * (store unwired, read failed); never zeros, never invented.
   */
  detector: Schema.optional(
    Schema.Struct({
      programKind: Schema.Literals([1, 2]),
      armed: Schema.Boolean,
      stateRevision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      lastEvaluationId: Schema.optional(Schema.String),
      latestResult: Schema.optional(
        Schema.Struct({
          result: ForgeDetectorResultSummary,
          asOfMs: UnixMillis,
        }),
      ),
      unavailable: Schema.optional(Schema.String),
    }),
  ),
  proposals: Schema.optional(Schema.Array(ForgePoolProposal)),
  policies: Schema.optional(Schema.Array(ForgePolicyBinding)),
  // P5.4 execution results (additive-optional; old payloads decode unchanged).
  /** `quote`: the immutable quote record, verbatim. */
  quoteRecord: Schema.optional(ForgeExecutionQuote),
  /** `propose_envelope`: the id the grant landed under. */
  envelopeId: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  /**
   * `envelope`: the grant view — envelope, its proposals, its intents, and
   * the host-computed remaining input budget in one read.
   */
  envelopeView: Schema.optional(
    Schema.Struct({
      envelope: ForgeExecutionEnvelopeView,
      proposals: Schema.Array(ForgeExecutionProposalView),
      intents: Schema.Array(ForgeSwapIntentView),
    }),
  ),
  /** `evaluate_policy`: the policy evaluator's outcome. */
  policyEvaluation: Schema.optional(ForgePolicyEvaluationView),
  /** `swap`: the prepared intent's summary, including its refusal state. */
  swapIntent: Schema.optional(ForgeSwapIntentView),
  /** `protected_swap`: the durable admission the reservation store returned. */
  protectedAdmission: Schema.optional(
    Schema.Struct({
      reservationId: Schema.String.check(Schema.isNonEmpty()),
      intentId: Schema.String.check(Schema.isNonEmpty()),
      replayed: Schema.Boolean,
    }),
  ),
  /** `capture_source`: the revisions one bounded capture wrote or refused. */
  generatedSourceCapture: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["ok", "unavailable"]),
      reason: Schema.optional(Schema.String),
      documents: Schema.Array(
        Schema.Struct({
          documentIdentity: Schema.String,
          revisionId: Schema.String,
          changed: Schema.Boolean,
          retracted: Schema.Boolean,
          publishedAtMs: Schema.NullOr(UnixMillis),
          timePrecision: Schema.String,
          firstObservedAtMs: UnixMillis,
          contentSha256: Schema.String,
          sourceUrl: Schema.String,
        }),
      ),
    }),
  ),
});
export type TradingForgeResult = typeof TradingForgeResult.Type;

/**
 * Everything one look answers.
 *
 * Every section is a fetch key's answer, so everything below `observedAt` and
 * `market` is optional: a call carries exactly what its keys named. The
 * mission half rides only when a mission-side key was named and the calling
 * thread holds a live mission; without one, those keys come back in
 * `unavailable` with a reason.
 */
export const TradingObservation = Schema.Struct({
  observedAt: UnixMillis,
  market: TradingMarket,

  // -- the market, as it is now ----------------------------------------------
  //
  // Every field below is optional for one reason: a look must never fail. The
  // exchange read is the half that can, and the moment it does is exactly when
  // the model most needs to be able to read its own position and mandate. A
  // failed market read costs these fields and nothing else.
  resolvedMarket: Schema.optional(ResolvedMarket),
  snapshot: Schema.optional(ObservedMarketSnapshot),
  /**
   * The book, bounded to {@link TRADING_LOOK_BOOK_LEVELS} a side — the depth
   * `microstructure` measures its readings over. Twenty levels rode every
   * full-book look and no turn ever quoted one (plan 35 phase 3).
   */
  orderBook: Schema.optional(OrderBook),
  /**
   * The lookback window the volatility and structure reads were taken over,
   * as a table rather than one keyed object per bar (plan 35 step 1).
   */
  candles: Schema.optional(MarketCandleSeries),
  /** Fluctuation on the mission's runtime timeframe. Gross of costs. */
  volatility: Schema.optional(ObservedVolatility),
  /**
   * The indicator readings this look asked for (`indicators:<spec>` keys),
   * computed server-side over the full fetched window. Present only when the
   * call named indicator keys.
   */
  indicators: Schema.optional(Schema.Array(IndicatorReading)),
  /** The same measurement one interval up; absent on the highest interval. */
  higherTimeframeVolatility: Schema.optional(ObservedVolatility),
  /** Direction, alignment, regime, and the scored candidates with their cost. */
  structure: Schema.optional(ObservedMarketStructure),
  /**
   * What the levels near the mark have already done to THIS mission — plan 27
   * B1, grouped with an ATR-scaled tolerance so 1899.7 and 1900.2 are one
   * level.
   *
   * Rides the `levels` key because it is read at the same moment as the
   * boundary it qualifies: the `range_reversion` doctrine says a level with
   * two `closedThrough` events is one the market has already gone through
   * twice, and one with a `stopOuts` entry has already ended a trade of this
   * mission's against the thesis. It was gathered by `observe` and dropped at
   * both exits — the doctrine pointed at a field nothing returned.
   */
  levelHistory: Schema.optional(Schema.Array(LevelHistoryEntry)),
  /**
   * The mission's previous structure read — plan 27 B2, and the other half of
   * the same gap.
   *
   * A boundary re-drawn in the same direction as the last read is a range
   * walking, and the walk is the trade. Absent until the mission has read
   * once.
   */
  previousStructureRead: Schema.optional(PreviousStructureRead),
  /**
   * What the book says, as readings — plan 29 phase 7. The same value the wake
   * carries, from the same read: a look and a wake quote one book, never two.
   */
  microstructure: Schema.optional(MarketMicrostructure),
  /**
   * Why the market half is missing, when it is. Present only then, so its
   * absence is the signal that everything above was read.
   */
  marketReadFailed: Schema.optional(Schema.String),

  /**
   * The one line of cost context (plan 29 step 3.1): the round trip in USD and
   * bps at a stated reference notional. Context for whether the expected move
   * pays, never a gate. Absent only when the cost read failed.
   */
  cost: Schema.optional(TradingCostContext),
  /**
   * The round trip on the position actually held, when one is. This is what
   * banking costs; `cost` above prices a hypothetical entry instead.
   */
  positionCosts: Schema.optional(TradingCostEstimate),

  // -- what the mission holds and has done -----------------------------------
  account: Schema.optional(AgentAccountSnapshot),
  /** Flat is `size: 0`, not an absence. Absent only on an unbound look. */
  position: Schema.optional(AgentNetPosition),
  openOrders: Schema.optional(Schema.Array(AgentOpenOrder)),
  /** This mission's completed orders, newest first, with their round trips. */
  trades: Schema.optional(TradingTradeHistory),

  /**
   * Mandate, authority, plan, watches, and pending executions.
   *
   * Optional: a catalog call or a fetch that named no mission-side key
   * carries no mission half, because the mission row is itself a priced
   * bundle.
   */
  mission: Schema.optional(TradingGetMissionResult),

  // -- the fetch path (plan 38 §2) ---------------------------------------------
  /**
   * The menu itself, when this call was the catalog call (`fetch` absent or
   * empty). The cheapest possible answer to "what can I ask
   * for?" — paid once per mission, not once per wake (§1.5).
   */
  menu: Schema.optional(Schema.String),
  /** The resolved keys this call actually served, echoed back. */
  fetched: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Archive-backed keys that could not be served, with the reason. The reason
   * must never read as data — no zeros, no empty series that would read as
   * "no funding" (§2.4).
   */
  unavailable: Schema.optional(
    Schema.Array(Schema.Struct({ key: Schema.String, reason: Schema.String })),
  ),

  // -- the fetch-only sections (plan 38 §2.2) ----------------------------------
  //
  // Each is one catalog key's answer, in its own field so no key implies
  // another (§2.3 rule 2) and so a size test can measure the section alone.
  /**
   * `book`: the two best levels with their sizes and the summed notional depth
   * over five levels a side — the spread and the liquidity behind it, without
   * the 898 characters of the full ten-level table.
   */
  book: Schema.optional(
    Schema.Struct({
      bid: Schema.Struct({ price: Schema.Number, size: Schema.Number }),
      ask: Schema.Struct({ price: Schema.Number, size: Schema.Number }),
      bidDepth5Usd: Schema.Number,
      askDepth5Usd: Schema.Number,
    }),
  ),
  /**
   * `structure_brief`: the alignment verdict and the single top-scored
   * candidate — the cheap option a reassessment turn currently lacks.
   */
  structureBrief: Schema.optional(
    Schema.Struct({
      alignment: TimeframeAlignment,
      topCandidate: Schema.optional(StrategyCandidate),
    }),
  ),
  /**
   * `events`: the mission's pending-event tail, newest last.
   * `deduplicationKey` is omitted — the summary and the moment are what a
   * turn reads.
   */
  events: Schema.optional(
    Schema.Array(
      Schema.Struct({ category: Schema.String, occurredAt: UnixMillis, summary: Schema.String }),
    ),
  ),
  /**
   * `funding_stats:<W>`: the trailing window's verdict, from the archive.
   * `meanPer8h` and `latestRatePer8h` are 8h-equivalent RATES (hourly archive
   * rate x 8), not percentages — unlike the snapshot's `fundingRatePct8h`,
   * which carries its unit in its name because it is the one a turn quotes.
   */
  fundingStats: Schema.optional(
    Schema.Struct({
      windowDays: Schema.Number,
      /** Mean of the hourly payments in the window, as an 8h-equivalent rate (x 8). */
      meanPer8h: Schema.Number,
      /** Latest hourly archive rate, as an 8h-equivalent rate (x 8). */
      latestRatePer8h: Schema.Number,
      latestTime: UnixMillis,
      signFlips: Schema.Number,
      sampleCount: Schema.Number,
    }),
  ),
  /**
   * `funding_series:<n>`: hourly funding rows, oldest first. `fundingRate` is
   * the raw per-hour rate the archive stores — a payment series, deliberately
   * NOT scaled to 8h (unlike `fundingStats`).
   */
  fundingSeries: Schema.optional(
    Schema.Array(Schema.Struct({ time: UnixMillis, fundingRate: Schema.Number })),
  ),
  /** `oi_premium:<n>`: asset-context samples, oldest first. */
  oiPremium: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ts: UnixMillis,
        openInterest: Schema.Number,
        premium: Schema.Number,
        oraclePx: Schema.Number,
        markPx: Schema.Number,
      }),
    ),
  ),
  /** `book_history:<n>`: book-summary rows, oldest first. */
  bookHistory: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ts: UnixMillis,
        bidPx: Schema.Number,
        askPx: Schema.Number,
        bidDepth5: Schema.Number,
        askDepth5: Schema.Number,
      }),
    ),
  ),
  /**
   * `scan`: one compact cross-market digest for every archived coin —
   * mark, 24h change, realized vol off 5m candles, funding now and 7d mean
   * (both 8h-equivalent rates: hourly archive rate x 8), 24h OI change.
   * Cross-market CONTEXT for the mission's own single market
   * (an ETH trader watches BTC because BTC leads), never instrument
   * selection: one asset per mission is settled elsewhere. A coin the
   * archive cannot answer is marked per coin (`unavailable` with a reason,
   * figures omitted), never by failing the whole key.
   */
  scan: Schema.optional(
    Schema.Array(
      Schema.Struct({
        coin: Schema.String,
        mark: Schema.optional(Schema.Number),
        change24hPct: Schema.optional(Schema.Number),
        realizedVol24hPct: Schema.optional(Schema.Number),
        /** Latest hourly archive rate x 8 (8h-equivalent). */
        fundingNowPer8h: Schema.optional(Schema.Number),
        /** Mean of the 7d hourly payments, as an 8h-equivalent rate (x 8). */
        funding7dMeanPer8h: Schema.optional(Schema.Number),
        oiChange24hPct: Schema.optional(Schema.Number),
        /** What could not be answered, and why — present exactly when a figure is absent. */
        unavailable: Schema.optional(Schema.String),
      }),
    ),
  ),
  /**
   * The UTC-day anchored session levels, served under the `levels` key:
   * prior UTC-day high/low/close and current UTC-day open/high/low from
   * archived 5m candles, plus the session VWAP (Σ typical·v / Σ v over the
   * current UTC day). Numbers the model arms ordinary `price` watches on —
   * a missing half is absent with its reason on `unavailable`, never a zero.
   */
  sessionLevels: Schema.optional(
    Schema.Struct({
      anchoredTo: Schema.Literal("utc_day"),
      interval: Schema.Literal("5m"),
      priorUtcDay: Schema.optional(
        Schema.Struct({ high: Schema.Number, low: Schema.Number, close: Schema.Number }),
      ),
      currentUtcDay: Schema.optional(
        Schema.Struct({ open: Schema.Number, high: Schema.Number, low: Schema.Number }),
      ),
      vwap: Schema.optional(Schema.Number),
      /** Which halves are missing, and why — absent when all three served. */
      unavailable: Schema.optional(Schema.String),
    }),
  ),
  /**
   * `forge` / `forge:<id>` / `forge:<id>:history`: the installed Forge
   * capabilities and their sealed evaluations. The catalog comes from the
   * capability store at runtime — an empty catalog is the honest empty
   * answer, and no detector is ever hardcoded into the fetch catalog.
   *
   * The three v2 fields are additive (detector-program capabilities): the
   * detector standing, the committed state revision, and the newest
   * committed detector result. All optional, all absent for v1 capabilities
   * and for scopes the serving runtime has not filled — a pre-existing
   * payload decodes unchanged.
   */
  forge: Schema.optional(
    Schema.Struct({
      catalog: Schema.Array(ForgeCapabilityCatalogEntry),
      latest: Schema.optional(ForgeEvaluationEvidence),
      history: Schema.optional(Schema.Array(ForgeEvaluationEvidence)),
      armed: Schema.optional(Schema.Boolean),
      detectorStateRevision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      latestDetectorResult: Schema.optional(ForgeDetectorResultSummary),
    }),
  ),
});
export type TradingObservation = typeof TradingObservation.Type;
