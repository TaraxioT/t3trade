/** Bounded, retained Graph inputs for the existing event-study calculation. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import {
  FORGE_MAX_WINDOW_SECONDS,
  observationsToCandles,
  type ForgeSwapObservation,
  type GraphDatasetManifest,
  type MarketCandle,
} from "@t3tools/trading-contracts";
import {
  eventStudyReadWindow,
  type EventStudyEntryBasis,
  type TradingEventOccurrence,
} from "@t3tools/trading-contracts/eventSets";
import { forgeJsonEncode } from "../forge/ForgeJsonEncode.ts";
import { ForgeGraphSource, FORGE_SWAPS_QUERY } from "../forge/GraphSource.ts";
import { ForgeSourceStore } from "../forge/ForgeSourceStore.ts";

export const GRAPH_STUDY_MAX_OCCURRENCES = 200;

// This hashes the decoder contract, not a remotely introspected Graph schema.
const EXPECTED_SWAP_FIELDS = [
  "id",
  "timestamp",
  "sender",
  "recipient",
  "amount0",
  "amount1",
  "sqrtPriceX96",
  "tick",
  "logIndex",
  "transaction.id",
] as const;

export interface GraphStudyDataset {
  readonly manifest: GraphDatasetManifest;
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly observations: ReadonlyArray<ForgeSwapObservation>;
  readonly quoteDecimals: number;
  readonly quoteSymbol: string;
}

export type GraphStudyDatasetRead =
  | { readonly status: "ok"; readonly dataset: GraphStudyDataset }
  | { readonly status: "unavailable"; readonly reason: string };

export interface GraphResearchServiceShape {
  readonly loadStudyDataset: (input: {
    readonly environmentId: string;
    readonly poolId: string;
    readonly market: string;
    readonly entryBasis: EventStudyEntryBasis;
    readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
    readonly intervalMs: number;
    readonly horizonBars: number;
    readonly now: number;
  }) => Effect.Effect<GraphStudyDatasetRead>;
}

export class GraphResearchService extends Context.Service<
  GraphResearchService,
  GraphResearchServiceShape
>()("t3/trading/research/GraphResearchService") {}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const makeGraphResearchService = Effect.gen(function* () {
  const source = yield* ForgeGraphSource;
  const store = yield* ForgeSourceStore;

  const loadStudyDataset: GraphResearchServiceShape["loadStudyDataset"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* source.settings;
      if (!settings.configured || settings.source === undefined) {
        return {
          status: "unavailable" as const,
          reason: settings.reason ?? "Graph source not configured",
        };
      }
      const config = settings.source;
      const pool = config.pools.find(
        (candidate) => candidate.poolId.toLowerCase() === input.poolId.toLowerCase(),
      );
      if (pool === undefined) {
        return {
          status: "unavailable" as const,
          reason: `pool ${input.poolId} is not a vetted Graph source pool`,
        };
      }
      const base = pool.baseIsToken1 ? pool.token1 : pool.token0;
      const quote = pool.baseIsToken1 ? pool.token0 : pool.token1;
      // ETH is the product's market name; WETH is its pool representation.
      const baseMarket = base.symbol === "WETH" ? "ETH" : base.symbol;
      if (input.market !== baseMarket && input.market !== base.symbol) {
        return {
          status: "unavailable" as const,
          reason: `pool base ${base.symbol} does not match market ${input.market}`,
        };
      }
      if (
        input.occurrences.length === 0 ||
        input.occurrences.length > GRAPH_STUDY_MAX_OCCURRENCES
      ) {
        return {
          status: "unavailable" as const,
          reason: `event set must contain 1–${GRAPH_STUDY_MAX_OCCURRENCES} occurrences (study cap)`,
        };
      }
      if (
        !Number.isSafeInteger(input.intervalMs) ||
        input.intervalMs < 1000 ||
        input.intervalMs % 1000 !== 0 ||
        !Number.isSafeInteger(input.horizonBars) ||
        input.horizonBars < 1 ||
        !Number.isSafeInteger(input.now) ||
        input.now < 0
      ) {
        return {
          status: "unavailable" as const,
          reason: "invalid study interval, horizon, or clock",
        };
      }
      // Fetch the same contiguous bar window as the archive path, including
      // baseline bars between occurrences. Per-occurrence fetches bias that baseline.
      const readWindow = eventStudyReadWindow(input.occurrences, input);
      // The archive selects bucket opens >= fromT; the recent-tail fallback
      // can begin between opens, so do not manufacture a partial first candle.
      const fromMs = Math.max(0, Math.ceil(readWindow.fromT / input.intervalMs) * input.intervalMs);
      const toMs = Math.min(
        input.now,
        Math.floor(readWindow.toT / input.intervalMs) * input.intervalMs + input.intervalMs,
      );
      const startedAt = Math.floor(fromMs / 1000);
      // Source bounds are inclusive seconds; never include the following bucket.
      const endedAt = Math.floor((toMs - 1) / 1000);
      if (endedAt <= startedAt || endedAt - startedAt > FORGE_MAX_WINDOW_SECONDS) {
        return {
          status: "unavailable" as const,
          reason:
            "Graph study read window exceeds the 24h source cap or is empty; narrow the event set and horizon",
        };
      }
      const fetch = yield* source.fetchWindow({
        poolId: pool.poolId,
        startedAt,
        endedAt,
        historical: true,
      });
      if (
        (fetch.status !== "complete" && fetch.status !== "empty") ||
        fetch.pinnedBlock === undefined ||
        fetch.pinnedBlockHash === undefined ||
        fetch.deployment !== config.deployment ||
        fetch.poolId.toLowerCase() !== pool.poolId.toLowerCase() ||
        fetch.window?.startedAt !== startedAt ||
        fetch.window.endedAt !== endedAt ||
        fetch.queryCapture?.query !== FORGE_SWAPS_QUERY ||
        fetch.queryCapture.variables.length === 0
      ) {
        return {
          status: "unavailable" as const,
          reason: fetch.reason ?? "Graph capture lacks complete pinned query provenance",
        };
      }
      const observations = [...(fetch.observations ?? [])].sort(
        (a, b) =>
          a.timestamp - b.timestamp ||
          (a.observationId < b.observationId ? -1 : a.observationId > b.observationId ? 1 : 0),
      );
      const contentSha256 = sha256(forgeJsonEncode(observations));
      const variablesSha256 = sha256(forgeJsonEncode(fetch.queryCapture.variables));
      const manifest: GraphDatasetManifest = {
        id: `ds_${sha256(
          forgeJsonEncode({
            environmentId: input.environmentId,
            poolId: pool.poolId,
            deployment: config.deployment,
            blockHash: fetch.pinnedBlockHash,
            fromMs,
            toMs,
            contentSha256,
            variablesSha256,
            capturedAtMs: fetch.fetchedAtMs,
          }),
        ).slice(0, 24)}`,
        environmentId: input.environmentId,
        provider: "the-graph",
        transport: "subgraph",
        chainId: "1",
        deploymentOrPackageId: config.deployment,
        schemaSha256: sha256(EXPECTED_SWAP_FIELDS.join(",")),
        programSha256: sha256(fetch.queryCapture.query),
        variablesSha256,
        requested: { fromMs, toMs },
        coverage: { fromMs, toMs, rows: observations.length },
        status: "complete",
        pin: { blockNumber: String(fetch.pinnedBlock), blockHash: fetch.pinnedBlockHash },
        cursor: null,
        normalizedSchemaVersion: 1,
        contentSha256,
        capturedAtMs: fetch.fetchedAtMs,
        availabilityBasis: "recorded",
        mode: "historical-replay",
      };
      // Use the manifest ID as the existing store's evidence handle. Retain
      // actual request variables and normalized bytes before exposing the manifest.
      const retained = yield* store
        .insert({
          record: {
            evidenceId: manifest.id,
            environmentId: input.environmentId,
            poolId: pool.poolId,
            historical: true,
            endpoint: config.endpoint,
            deployment: config.deployment,
            pinnedBlock: fetch.pinnedBlock,
            pinnedBlockHash: fetch.pinnedBlockHash,
            windowStart: startedAt,
            windowEnd: endedAt,
            fetchedAtMs: fetch.fetchedAtMs,
            digest: contentSha256,
            observationCount: observations.length,
          },
          observations,
          queryCapture: fetch.queryCapture,
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!retained)
        return {
          status: "unavailable" as const,
          reason: "could not retain Graph research evidence",
        };
      return {
        status: "ok" as const,
        dataset: {
          manifest,
          observations,
          candles: observationsToCandles(observations, { intervalMs: input.intervalMs }),
          quoteDecimals: quote.decimals,
          quoteSymbol: quote.symbol,
        },
      };
    });
  return GraphResearchService.of({ loadStudyDataset });
});
