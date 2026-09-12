/** Bounded, retained Graph inputs for the existing event-study calculation. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import { createHash } from "node:crypto";
import {
  FORGE_MAX_WINDOW_SECONDS,
  observationsToCandles,
  type ForgeQueryCapture,
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

/**
 * Request budget: one study window costs at most this many 24h segments.
 * Above it the read is refused up front instead of walked.
 */
export const GRAPH_STUDY_MAX_SEGMENTS = 90;

/** Row budget across every segment of one acquisition. */
export const GRAPH_STUDY_MAX_TOTAL_ROWS = 50_000;

/** Wall-clock budget for one multi-segment acquisition. */
export const GRAPH_STUDY_MAX_ACQUIRE_MS = 120_000;

/**
 * A retained capture may be reused only once its requested window ends at
 * least this far before the capture time: a window ending recently may not
 * be fully indexed in an older capture.
 */
export const GRAPH_STUDY_REUSE_FRESHNESS_MS = 3_600_000;

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
  /** Present only when a budget stopped the acquisition short of the request. */
  readonly partialReason?: string;
  /** True when served from retained evidence, false when freshly acquired. */
  readonly reused: boolean;
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
    /** Explicit lineage: serve exactly this retained dataset or refuse. */
    readonly datasetId?: string;
  }) => Effect.Effect<GraphStudyDatasetRead>;
}

export class GraphResearchService extends Context.Service<
  GraphResearchService,
  GraphResearchServiceShape
>()("t3/trading/research/GraphResearchService") {}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** One bounded piece of the study window, inclusive unix seconds. */
interface StudySegment {
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * Tile [startedAt, endedAt] with contiguous inclusive-second segments, each
 * inside the source's one-fetch cap. A segment ends one second before the
 * next begins, so a boundary observation belongs to exactly one segment,
 * and every previously single-fetchable window stays exactly one segment.
 */
const planStudySegments = (startedAt: number, endedAt: number): ReadonlyArray<StudySegment> => {
  const segments: Array<StudySegment> = [];
  let cursor = startedAt;
  while (cursor <= endedAt) {
    const segmentEnd = Math.min(cursor + FORGE_MAX_WINDOW_SECONDS, endedAt);
    segments.push({ startedAt: cursor, endedAt: segmentEnd });
    cursor = segmentEnd + 1;
  }
  return segments;
};

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
      if (endedAt <= startedAt) {
        return {
          status: "unavailable" as const,
          reason: "Graph study read window is empty; narrow the event set and horizon",
        };
      }

      // Reuse applies the full lineage verification below; a dataset that
      // fails any check is refused when named explicitly and merely skipped
      // during auto-reuse, falling through to a fresh acquisition.
      const tryReuse = (evidenceId: string) =>
        Effect.gen(function* () {
          const retained = yield* store.readObservations(evidenceId);
          if (retained === null) {
            return { status: "rejected" as const, reason: `dataset ${evidenceId} is not retained` };
          }
          const { record, observations, claimedCount, queryCapture } = retained;
          if (record.poolId.toLowerCase() !== pool.poolId.toLowerCase()) {
            return {
              status: "rejected" as const,
              reason: `dataset ${evidenceId} was captured for pool ${record.poolId}`,
            };
          }
          if (record.environmentId !== input.environmentId) {
            return {
              status: "rejected" as const,
              reason: `dataset ${evidenceId} belongs to another environment`,
            };
          }
          if (record.deployment !== config.deployment) {
            return {
              status: "rejected" as const,
              reason: `dataset ${evidenceId} was captured against deployment ${record.deployment}`,
            };
          }
          if (queryCapture === undefined) {
            return {
              status: "rejected" as const,
              reason: `dataset ${evidenceId} lacks retained query provenance`,
            };
          }
          if (claimedCount !== observations.length) {
            return {
              status: "rejected" as const,
              reason: `dataset ${evidenceId} payload holds ${observations.length} of ${claimedCount} claimed rows`,
            };
          }
          if (record.pinnedBlockHash === undefined) {
            return {
              status: "rejected" as const,
              reason: `dataset ${evidenceId} lacks its pinned block hash`,
            };
          }
          // Records store inclusive second bounds, so the covered span ends
          // one second past windowEnd; the request is covered when the row
          // reaches both grid-aligned edges.
          if (record.windowStart * 1000 > fromMs || (record.windowEnd + 1) * 1000 < toMs) {
            return {
              status: "rejected" as const,
              reason: `dataset ${evidenceId} does not cover the study window`,
            };
          }
          const contentSha256 = sha256(forgeJsonEncode(observations));
          if (contentSha256 !== record.digest) {
            return {
              status: "rejected" as const,
              reason: `dataset ${evidenceId} failed integrity verification`,
            };
          }
          const variablesSha256 = sha256(forgeJsonEncode(queryCapture.variables));
          const reconstructed = `ds_${sha256(
            forgeJsonEncode({
              environmentId: input.environmentId,
              poolId: pool.poolId,
              deployment: config.deployment,
              blockHash: record.pinnedBlockHash,
              fromMs,
              toMs,
              contentSha256,
              variablesSha256,
              capturedAtMs: record.fetchedAtMs,
            }),
          ).slice(0, 24)}`;
          if (reconstructed !== record.evidenceId) {
            return {
              status: "rejected" as const,
              reason: `dataset ${evidenceId} failed integrity verification`,
            };
          }
          const manifest: GraphDatasetManifest = {
            id: record.evidenceId,
            environmentId: input.environmentId,
            provider: "the-graph",
            transport: "subgraph",
            chainId: "1",
            deploymentOrPackageId: config.deployment,
            schemaSha256: sha256(EXPECTED_SWAP_FIELDS.join(",")),
            programSha256: sha256(queryCapture.query),
            variablesSha256,
            requested: { fromMs, toMs },
            coverage: {
              fromMs: record.windowStart * 1000,
              toMs: (record.windowEnd + 1) * 1000,
              rows: observations.length,
            },
            status: "complete",
            pin: { blockNumber: String(record.pinnedBlock), blockHash: record.pinnedBlockHash },
            cursor: null,
            normalizedSchemaVersion: 1,
            contentSha256,
            capturedAtMs: record.fetchedAtMs,
            availabilityBasis: "recorded",
            mode: "historical-replay",
          };
          return {
            status: "reused" as const,
            dataset: {
              manifest,
              observations,
              candles: observationsToCandles(observations, { intervalMs: input.intervalMs }),
              quoteDecimals: quote.decimals,
              quoteSymbol: quote.symbol,
              reused: true,
            } satisfies GraphStudyDataset,
          };
        });

      if (input.datasetId !== undefined) {
        const outcome = yield* tryReuse(input.datasetId).pipe(
          Effect.orElseSucceed((): { readonly status: "rejected"; readonly reason: string } => ({
            status: "rejected",
            reason: `dataset ${input.datasetId} could not be read from retention`,
          })),
        );
        if (outcome.status === "reused") return { status: "ok" as const, dataset: outcome.dataset };
        return { status: "unavailable" as const, reason: outcome.reason };
      }

      // Auto-reuse: newest covering "ds_" row that is fresh enough and passes
      // every explicit-lineage check. Integrity failures skip, never abort.
      const candidates = yield* store
        .listRecent({
          environmentId: input.environmentId,
          poolId: pool.poolId,
          limit: 100,
        })
        .pipe(Effect.orElseSucceed(() => []));
      for (const candidate of candidates) {
        if (!candidate.evidenceId.startsWith("ds_")) continue;
        if (candidate.windowStart * 1000 > fromMs || (candidate.windowEnd + 1) * 1000 < toMs) {
          continue;
        }
        if (toMs > candidate.fetchedAtMs - GRAPH_STUDY_REUSE_FRESHNESS_MS) continue;
        const outcome = yield* tryReuse(candidate.evidenceId).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (outcome?.status === "reused")
          return { status: "ok" as const, dataset: outcome.dataset };
      }

      const segments = planStudySegments(startedAt, endedAt);
      if (segments.length > GRAPH_STUDY_MAX_SEGMENTS) {
        return {
          status: "unavailable" as const,
          reason: `study window needs ${segments.length} segments, above the ${GRAPH_STUDY_MAX_SEGMENTS}-segment request cap; narrow the event set and horizon`,
        };
      }
      // A multi-segment capture must describe one chain state, so every
      // segment is pinned to the block resolved here. A single-segment window
      // keeps the source's own per-fetch pin.
      let sharedPin: number | undefined;
      if (segments.length > 1) {
        const health = yield* source.probeHealth;
        if (typeof health.latestBlock !== "number") {
          return {
            status: "unavailable" as const,
            reason: "could not resolve a shared pin for a multi-segment capture",
          };
        }
        sharedPin = health.latestBlock;
      }
      const acquireStartMs = yield* Clock.currentTimeMillis;
      const observations: Array<ForgeSwapObservation> = [];
      const seenIds = new Set<string>();
      const variables: Array<ForgeQueryCapture["variables"][number]> = [];
      const blockHashVerification: NonNullable<
        ForgeQueryCapture["blockHashVerification"]
      >[number][] = [];
      let pinnedBlock: number | undefined;
      let pinnedBlockHash: string | undefined;
      let capturedAtMs = 0;
      let coveredEndAt = startedAt - 1;
      let partialReason: string | undefined;
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        // The prefix always holds at least one segment: the budget is only
        // checked between segments, so a partial dataset is never empty.
        if (index > 0) {
          const elapsedMs = (yield* Clock.currentTimeMillis) - acquireStartMs;
          if (elapsedMs > GRAPH_STUDY_MAX_ACQUIRE_MS) {
            partialReason = `acquisition exceeded the ${GRAPH_STUDY_MAX_ACQUIRE_MS}ms budget after ${index} of ${segments.length} segments`;
            break;
          }
        }
        const fetch = yield* source.fetchWindow({
          poolId: pool.poolId,
          startedAt: segment.startedAt,
          endedAt: segment.endedAt,
          historical: true,
          ...(sharedPin === undefined ? {} : { pinnedBlock: sharedPin }),
        });
        if (
          (fetch.status !== "complete" && fetch.status !== "empty") ||
          fetch.pinnedBlock === undefined ||
          fetch.pinnedBlockHash === undefined ||
          fetch.deployment !== config.deployment ||
          fetch.poolId.toLowerCase() !== pool.poolId.toLowerCase() ||
          fetch.window?.startedAt !== segment.startedAt ||
          fetch.window.endedAt !== segment.endedAt ||
          fetch.queryCapture?.query !== FORGE_SWAPS_QUERY ||
          fetch.queryCapture.variables.length === 0
        ) {
          return {
            status: "unavailable" as const,
            reason: `segment ${segment.startedAt}..${segment.endedAt}: ${fetch.reason ?? "Graph capture lacks complete pinned query provenance"}`,
          };
        }
        if (
          pinnedBlockHash !== undefined &&
          (fetch.pinnedBlock !== pinnedBlock || fetch.pinnedBlockHash !== pinnedBlockHash)
        ) {
          return {
            status: "unavailable" as const,
            reason: `segment ${segment.startedAt}..${segment.endedAt} drifted to block ${fetch.pinnedBlock} (${fetch.pinnedBlockHash}) under a capture pinned to ${pinnedBlock} (${pinnedBlockHash})`,
          };
        }
        pinnedBlock = fetch.pinnedBlock;
        pinnedBlockHash = fetch.pinnedBlockHash;
        capturedAtMs = Math.max(capturedAtMs, fetch.fetchedAtMs);
        for (const variable of fetch.queryCapture.variables) variables.push(variable);
        blockHashVerification.push(...(fetch.queryCapture.blockHashVerification ?? []));
        for (const observation of fetch.observations ?? []) {
          // Segments do not overlap; dedupe is a safety net against a source
          // echoing a boundary row into two segments.
          if (seenIds.has(observation.observationId)) continue;
          seenIds.add(observation.observationId);
          observations.push(observation);
        }
        coveredEndAt = segment.endedAt;
        if (observations.length > GRAPH_STUDY_MAX_TOTAL_ROWS) {
          partialReason = `acquisition exceeded the ${GRAPH_STUDY_MAX_TOTAL_ROWS}-row budget after segment ${segment.startedAt}..${segment.endedAt}`;
          break;
        }
      }
      if (pinnedBlock === undefined || pinnedBlockHash === undefined) {
        return {
          status: "unavailable" as const,
          reason: "no segment was acquired",
        };
      }
      observations.sort(
        (a, b) =>
          a.timestamp - b.timestamp ||
          a.logIndex - b.logIndex ||
          (a.observationId < b.observationId ? -1 : a.observationId > b.observationId ? 1 : 0),
      );
      const contentSha256 = sha256(forgeJsonEncode(observations));
      const queryCapture: ForgeQueryCapture = {
        query: FORGE_SWAPS_QUERY,
        variables,
        ...(blockHashVerification.length === 0 ? {} : { blockHashVerification }),
      };
      const variablesSha256 = sha256(forgeJsonEncode(variables));
      const complete = partialReason === undefined;
      const manifest: GraphDatasetManifest = {
        id: `ds_${sha256(
          forgeJsonEncode({
            environmentId: input.environmentId,
            poolId: pool.poolId,
            deployment: config.deployment,
            blockHash: pinnedBlockHash,
            fromMs,
            toMs,
            contentSha256,
            variablesSha256,
            capturedAtMs,
          }),
        ).slice(0, 24)}`,
        environmentId: input.environmentId,
        provider: "the-graph",
        transport: "subgraph",
        chainId: "1",
        deploymentOrPackageId: config.deployment,
        schemaSha256: sha256(EXPECTED_SWAP_FIELDS.join(",")),
        programSha256: sha256(queryCapture.query),
        variablesSha256,
        requested: { fromMs, toMs },
        coverage: complete
          ? { fromMs, toMs, rows: observations.length }
          : // Coverage ends one second past the last covered second — the
            // exclusive-end convention the complete path and the retention
            // reconstruction both use, so a reused row reports what it did.
            { fromMs, toMs: (coveredEndAt + 1) * 1000, rows: observations.length },
        status: complete ? "complete" : "partial",
        pin: { blockNumber: String(pinnedBlock), blockHash: pinnedBlockHash },
        cursor: null,
        normalizedSchemaVersion: 1,
        contentSha256,
        capturedAtMs,
        availabilityBasis: "recorded",
        mode: "historical-replay",
      };
      // Use the manifest ID as the existing store's evidence handle. Retain
      // actual request variables and normalized bytes before exposing the
      // manifest. A partial capture records its actual covered end so the row
      // never claims coverage its payload lacks.
      const retained = yield* store
        .insert({
          record: {
            evidenceId: manifest.id,
            environmentId: input.environmentId,
            poolId: pool.poolId,
            historical: true,
            endpoint: config.endpoint,
            deployment: config.deployment,
            pinnedBlock,
            pinnedBlockHash,
            windowStart: startedAt,
            windowEnd: coveredEndAt,
            fetchedAtMs: capturedAtMs,
            digest: contentSha256,
            observationCount: observations.length,
          },
          observations,
          queryCapture,
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
          ...(partialReason === undefined ? {} : { partialReason }),
          reused: false,
        },
      };
    });
  return GraphResearchService.of({ loadStudyDataset });
});
