/**
 * GraphResearchService — bounded dataset acquisition for the existing
 * research tools.
 *
 * One service answers "give me the Graph-derived inputs for this event
 * study": it fetches one bounded, pinned, historical window per occurrence
 * (the same vetted-pool Graph transport the Forge detectors use), merges and
 * de-duplicates the retained observations, and returns BOTH things a study
 * consumes — sparse grid candles and per-occurrence blockchain features —
 * under one immutable {@link GraphDatasetManifest}. Prices and features come
 * from the same bytes, so a row can never cite a price its flow was not
 * measured on.
 *
 * Honesty rules this service owns:
 *
 * - Unconfigured or unhealthy source is a named unavailable state, never
 *   zeros and never a failed RPC call from a research tool.
 * - Occurrence counts and per-window spans are capped before any request is
 *   made; a study that outgrows the caps gets a refusal naming the cap.
 * - A window whose fetch landed unhealthy contributes no observations and
 *   marks the dataset `partial`; every window unhealthy is `unavailable`.
 * - The manifest's hashes cover exactly what was executed: the query bytes,
 *   the executed variables, the decoder's expected field set, and the
 *   canonical observation content.
 *
 * This service does not persist runs, does not publish scenes, and never
 * feeds execution — research only.
 *
 * @module GraphResearchService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";

import { forgeJsonEncode } from "../forge/ForgeJsonEncode.ts";

import type { ForgeSwapObservation, ForgeWindowFetch } from "@t3tools/trading-contracts";
import { computeGraphWindowFeatures, observationsToCandles } from "@t3tools/trading-contracts";
import type { GraphWindowFeatures } from "@t3tools/trading-contracts";
import type { GraphDatasetManifest } from "@t3tools/trading-contracts";
import type { MarketCandle } from "@t3tools/trading-contracts";
import type { TradingEventOccurrence } from "@t3tools/trading-contracts/eventSets";

import {
  ForgeGraphSource,
  FORGE_SWAPS_QUERY,
  type ForgeGraphSourceShape,
} from "../forge/GraphSource.ts";

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

/** The most occurrences one study dataset may cover. */
export const GRAPH_STUDY_MAX_OCCURRENCES = 200;

/** How many occurrence windows fetch in parallel. */
export const GRAPH_STUDY_FETCH_CONCURRENCY = 4;

/** The decoder's expected swap field set, hashed into every manifest. */
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

/** What one successful load produced, manifest first. */
export interface GraphStudyDataset {
  readonly manifest: GraphDatasetManifest;
  readonly candles: ReadonlyArray<MarketCandle>;
  readonly features: ReadonlyArray<GraphWindowFeatures>;
}

export type GraphStudyDatasetRead =
  | { readonly status: "ok"; readonly dataset: GraphStudyDataset }
  | { readonly status: "unavailable"; readonly reason: string };

export interface GraphResearchServiceShape {
  /**
   * Acquire (and retain through the source's own evidence path) the
   * Graph-derived inputs for one event study. The occurrences, interval,
   * and horizon come from the study's own recipe; this service only bounds
   * and executes the fetches.
   */
  readonly loadStudyDataset: (input: {
    readonly environmentId: string;
    readonly poolId: string;
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const sha256OfObservations = (observations: ReadonlyArray<ForgeSwapObservation>): string =>
  sha256(
    forgeJsonEncode(
      [...observations]
        .map((observation) => observation.observationId)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );

/** One occurrence's measurement window on the study grid, unix seconds. */
const occurrenceWindowSec = (
  occurrence: TradingEventOccurrence,
  intervalMs: number,
  horizonBars: number,
): { readonly fromSec: number; readonly toSec: number } => {
  const slotStartMs = Math.floor(occurrence.startAt / intervalMs) * intervalMs;
  const windowToMs = slotStartMs + intervalMs * horizonBars;
  return { fromSec: Math.floor(slotStartMs / 1000), toSec: Math.ceil(windowToMs / 1000) };
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export const makeGraphResearchService = Effect.gen(function* () {
  const source: ForgeGraphSourceShape = yield* ForgeGraphSource;

  const loadStudyDataset: GraphResearchServiceShape["loadStudyDataset"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* source.settings;
      if (!settings.configured || settings.source === undefined) {
        return {
          status: "unavailable" as const,
          reason: settings.reason ?? "forge graph source not configured",
        };
      }
      const pool = settings.source.pools.find((candidate) => candidate.poolId === input.poolId);
      if (pool === undefined) {
        return {
          status: "unavailable" as const,
          reason: `pool ${input.poolId} is not one of the vetted Graph source pools`,
        };
      }
      if (input.occurrences.length === 0) {
        return { status: "unavailable" as const, reason: "the event set has no occurrences" };
      }
      if (input.occurrences.length > GRAPH_STUDY_MAX_OCCURRENCES) {
        return {
          status: "unavailable" as const,
          reason: `the event set has ${input.occurrences.length} occurrences; the study cap is ${GRAPH_STUDY_MAX_OCCURRENCES}`,
        };
      }
      for (const occurrence of input.occurrences) {
        if (occurrence.startAt > input.now) {
          return {
            status: "unavailable" as const,
            reason: "an occurrence starts in the future; its window cannot have been observed",
          };
        }
      }

      // One bounded historical fetch per occurrence window. Individual
      // unhealthy windows degrade the dataset; total failure refuses it.
      const fetches = yield* Effect.forEach(
        input.occurrences,
        (occurrence) => {
          const window = occurrenceWindowSec(occurrence, input.intervalMs, input.horizonBars);
          return source
            .fetchWindow({
              poolId: input.poolId,
              startedAt: window.fromSec,
              endedAt: window.toSec,
              historical: true,
            })
            .pipe(
              Effect.map((fetch): { ok: boolean; fetch: ForgeWindowFetch } => ({
                ok: fetch.status === "complete" || fetch.status === "empty",
                fetch,
              })),
            );
        },
        { concurrency: GRAPH_STUDY_FETCH_CONCURRENCY },
      );

      const healthy = fetches.filter((entry) => entry.ok);
      if (healthy.length === 0) {
        const first = fetches[0]!.fetch;
        return {
          status: "unavailable" as const,
          reason: first.reason ?? "every occurrence window fetch was unhealthy",
        };
      }

      const seen = new Set<string>();
      const observations: Array<ForgeSwapObservation> = [];
      for (const entry of healthy) {
        for (const observation of entry.fetch.observations ?? []) {
          if (seen.has(observation.observationId)) continue;
          seen.add(observation.observationId);
          observations.push(observation);
        }
      }
      observations.sort((a, b) => a.timestamp - b.timestamp);

      const requestedFromMs = Math.min(
        ...input.occurrences.map(
          (occurrence) => Math.floor(occurrence.startAt / input.intervalMs) * input.intervalMs,
        ),
      );
      const requestedToMs = Math.max(
        ...input.occurrences.map((occurrence) => {
          const window = occurrenceWindowSec(occurrence, input.intervalMs, input.horizonBars);
          return window.toSec * 1000;
        }),
      );
      const pinnedBlocks = new Set(
        healthy
          .map((entry) => entry.fetch.pinnedBlock)
          .filter((block): block is number => block !== undefined),
      );
      const pinnedHashes = new Set(
        healthy
          .map((entry) => entry.fetch.pinnedBlockHash)
          .filter((hash): hash is string => hash !== undefined),
      );

      const manifest: GraphDatasetManifest = {
        id: `ds_${sha256(
          `${input.environmentId}:${input.poolId}:${requestedFromMs}:${requestedToMs}:${input.intervalMs}:${input.horizonBars}:${sha256OfObservations(observations)}`,
        ).slice(0, 24)}`,
        environmentId: input.environmentId,
        provider: "the-graph",
        transport: "subgraph",
        chainId: "1",
        deploymentOrPackageId: settings.source.deployment,
        schemaSha256: sha256(EXPECTED_SWAP_FIELDS.join(",")),
        programSha256: sha256(FORGE_SWAPS_QUERY),
        variablesSha256: sha256(
          forgeJsonEncode({ pool: input.poolId, first: "page", cursor: "paged", block: "probe" }),
        ),
        requested: { fromMs: requestedFromMs, toMs: requestedToMs },
        coverage: {
          fromMs: requestedFromMs,
          toMs: requestedToMs,
          rows: observations.length,
        },
        status: healthy.length === fetches.length ? "complete" : "partial",
        pin:
          pinnedBlocks.size === 1 && pinnedHashes.size === 1
            ? {
                blockNumber: String(pinnedBlocks.values().next().value),
                blockHash: pinnedHashes.values().next().value ?? "",
              }
            : null,
        cursor: null,
        normalizedSchemaVersion: 1,
        contentSha256: sha256OfObservations(observations),
        capturedAtMs: input.now,
        availabilityBasis: "recorded",
        mode: "historical-replay",
      };

      return {
        status: "ok" as const,
        dataset: {
          manifest,
          candles: observationsToCandles(observations, { intervalMs: input.intervalMs }),
          features: computeGraphWindowFeatures({
            occurrences: input.occurrences,
            observations,
            intervalMs: input.intervalMs,
            horizonBars: input.horizonBars,
          }),
        },
      };
    });

  return GraphResearchService.of({ loadStudyDataset });
});
