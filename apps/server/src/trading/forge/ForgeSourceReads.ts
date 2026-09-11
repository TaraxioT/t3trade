/**
 * ForgeSourceReads — the server-side read models for the Forge UI handoff.
 *
 * Three reads, all source-only (no Hyperliquid, no signer, no mission):
 *
 * - `listSources`: what pools exist and how the source is doing. Works with
 *   no Hyperliquid thread market — Forge is a source in its own right, so a
 *   thread whose `threadMarket` is null still discovers it.
 * - `readPoolSeries`: a bounded per-pool swap series with an explicit UTC
 *   domain, real points, the complete anchor-candidate set, gaps, coverage,
 *   provenance, and source health. Pool activity is never coerced into
 *   Hyperliquid candles, and an unavailable source is an unavailable answer,
 *   never zeros.
 * - `captureHistoricalWindow`: retain one bounded window (≤24h) across the
 *   approved pools, pinned to one block, labeled historical with its original
 *   block and time — the artifact the eventual v1/v2 comparison replays.
 *
 * These are the read models F4/U0 wires into transport; registering the wire
 * schemas belongs to that phase because the RPC surface lives in
 * `packages/contracts`.
 *
 * @module ForgeSourceReads
 */
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";

import {
  capSeriesPoints,
  FORGE_MAX_SERIES_POINTS,
  FORGE_MAX_WINDOW_SECONDS,
  forgeSeriesGaps,
  type ForgeHistoricalCapture,
  type ForgePoolSeries,
  type ForgeSourceHealth,
  type ForgeSourceListing,
  type ForgeSwapObservation,
  type ForgeWindowFetch,
} from "@t3tools/trading-contracts";

import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import { ForgeGraphSource, type ForgeGraphSettings } from "./GraphSource.ts";
import { ForgeSourceStore, type ForgeEvidenceInsert } from "./ForgeSourceStore.ts";

/** Default live-series domain: the most recent hour. */
const DEFAULT_SERIES_WINDOW_MS = 60 * 60_000;

/** A gap longer than this (seconds) is named in `gaps`. Matches the anchor buffer. */
const SERIES_GAP_SECONDS = 300;

export interface ForgePoolSeriesReadInput {
  readonly poolId: string;
  /** UTC millis. Default: `endUtcMs - 1h`. */
  readonly startUtcMs?: number;
  /** UTC millis. Default: now. */
  readonly endUtcMs?: number;
  /** Point cap. Default and maximum: {@link FORGE_MAX_SERIES_POINTS}. */
  readonly maxPoints?: number;
}

/** The series read: either a real series or a named non-answer. */
export type ForgePoolSeriesRead =
  | { readonly status: "ok"; readonly series: ForgePoolSeries }
  | { readonly status: "unavailable"; readonly reason: string };

/** The listing read: the configured sources, or the named unconfigured state. */
export type ForgeSourceListingRead =
  | { readonly status: "ok"; readonly listing: ForgeSourceListing }
  | { readonly status: "unavailable"; readonly reason: string };

export type ForgeHistoricalCaptureRead =
  | { readonly status: "ok"; readonly capture: ForgeHistoricalCapture }
  | { readonly status: "unavailable"; readonly reason: string };

export interface ForgeSourceReadsShape {
  readonly listSources: Effect.Effect<ForgeSourceListingRead>;
  readonly readPoolSeries: (input: ForgePoolSeriesReadInput) => Effect.Effect<ForgePoolSeriesRead>;
  readonly readEvidence: (
    evidenceId: string,
  ) => Effect.Effect<
    (ForgeEvidenceInsert & { readonly claimedCount: number }) | null,
    PersistenceSqlError
  >;
  /** Retain one bounded historical window across all approved pools. */
  readonly captureHistoricalWindow: (input: {
    readonly environmentId: string;
    readonly startedAt: number;
    readonly endedAt: number;
  }) => Effect.Effect<ForgeHistoricalCaptureRead, PersistenceSqlError>;
}

const unavailableSeries = (reason: string): ForgePoolSeriesRead => ({
  status: "unavailable",
  reason,
});
const okSeries = (series: ForgePoolSeries): ForgePoolSeriesRead => ({
  status: "ok",
  series,
});
const unavailableListing = (reason: string): ForgeSourceListingRead => ({
  status: "unavailable",
  reason,
});
const okListing = (listing: ForgeSourceListing): ForgeSourceListingRead => ({
  status: "ok",
  listing,
});
const unavailableCapture = (reason: string): ForgeHistoricalCaptureRead => ({
  status: "unavailable",
  reason,
});
const okCapture = (capture: ForgeHistoricalCapture): ForgeHistoricalCaptureRead => ({
  status: "ok",
  capture,
});

export class ForgeSourceReads extends Context.Service<ForgeSourceReads, ForgeSourceReadsShape>()(
  "t3/trading/forge/ForgeSourceReads",
) {}

export const makeForgeSourceReads = Effect.gen(function* () {
  const source = yield* ForgeGraphSource;
  const store = yield* ForgeSourceStore;

  /** Health implied by a fetch's own state, so series and fetch agree. */
  const healthOf = (fetch: ForgeWindowFetch, probe: ForgeSourceHealth): ForgeSourceHealth =>
    fetch.status === "stale"
      ? {
          ...probe,
          status: "stale",
          ...(fetch.reason === undefined ? {} : { reason: fetch.reason }),
        }
      : fetch.status === "unavailable"
        ? {
            ...probe,
            status: "unavailable",
            ...(fetch.reason === undefined ? {} : { reason: fetch.reason }),
          }
        : probe;

  const listSources: Effect.Effect<ForgeSourceListingRead> = Effect.gen(function* () {
    const settings: ForgeGraphSettings = yield* source.settings;
    if (!settings.configured || settings.source === undefined) {
      return unavailableListing(settings.reason ?? "forge graph source not configured");
    }
    const health = yield* source.probeHealth;
    return okListing({
      config: settings.source,
      pools: settings.source.pools.map((pool) => ({
        poolId: pool.poolId,
        label: pool.label,
        feeTierHundredthsBps: pool.feeTierHundredthsBps,
        quoteUnits: "USDC-per-WETH",
      })),
      health,
    });
  });

  const readPoolSeries = (input: ForgePoolSeriesReadInput): Effect.Effect<ForgePoolSeriesRead> =>
    Effect.gen(function* () {
      const settings = yield* source.settings;
      if (!settings.configured || settings.source === undefined) {
        return unavailableSeries(settings.reason ?? "forge graph source not configured");
      }
      const now = yield* Clock.currentTimeMillis;
      const endUtcMs = input.endUtcMs ?? now;
      const startUtcMs = input.startUtcMs ?? endUtcMs - DEFAULT_SERIES_WINDOW_MS;
      if (startUtcMs >= endUtcMs) {
        return unavailableSeries("series domain start must be before its end");
      }
      if (endUtcMs - startUtcMs > FORGE_MAX_WINDOW_SECONDS * 1000) {
        return unavailableSeries("series domain exceeds the 24h bound");
      }
      const maxPoints = Math.min(
        input.maxPoints === undefined ? FORGE_MAX_SERIES_POINTS : input.maxPoints,
        FORGE_MAX_SERIES_POINTS,
      );
      const startedAt = Math.floor(startUtcMs / 1000);
      const endedAt = Math.floor(endUtcMs / 1000);

      const fetch = yield* source.fetchWindow({ poolId: input.poolId, startedAt, endedAt });
      if (fetch.status === "unavailable") {
        return unavailableSeries(fetch.reason ?? "source unavailable");
      }
      const deployment = fetch.deployment ?? settings.source.deployment;
      const probe = yield* source.probeHealth;

      const served = capSeriesPoints(
        (fetch.observations ?? []).map((observation) => ({
          t: observation.timestamp,
          priceQuotePerBaseMicros: observation.priceQuotePerBaseMicros,
          quoteVolumeMicros: observation.quoteVolumeMicros,
          observationId: observation.observationId,
        })),
        maxPoints,
      );
      const candidates = fetch.anchorCandidates ?? [];
      // The display anchor is the NEAREST candidate; the full candidate set
      // rides beside it so which one qualifies is never the fetch's decision.
      const nearest = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;

      return okSeries({
        poolId: fetch.poolId,
        chain: "ethereum-mainnet",
        quoteUnits: "USDC-per-WETH",
        domainUtcMs: { start: startUtcMs, end: endUtcMs },
        maxPoints,
        points: [...served],
        anchor:
          nearest === undefined
            ? { status: "missing" }
            : {
                status: "covered",
                observationId: nearest.observation.observationId,
                priceQuotePerBaseMicros: nearest.observation.priceQuotePerBaseMicros,
                ageBeforeWindowSeconds: nearest.ageBeforeWindowSeconds,
              },
        anchorCandidates: candidates.map((candidate) => ({
          observationId: candidate.observation.observationId,
          priceQuotePerBaseMicros: candidate.observation.priceQuotePerBaseMicros,
          quoteVolumeMicros: candidate.observation.quoteVolumeMicros,
          ageBeforeWindowSeconds: candidate.ageBeforeWindowSeconds,
        })),
        gaps: [...forgeSeriesGaps(served, startedAt, endedAt, SERIES_GAP_SECONDS)],
        coverage: {
          ...(served.length === 0
            ? {}
            : {
                firstObservedUnixSeconds: served[0]!.t,
                lastObservedUnixSeconds: served[served.length - 1]!.t,
              }),
        },
        provenance: {
          deployment,
          ...(fetch.pinnedBlock === undefined ? {} : { pinnedBlock: fetch.pinnedBlock }),
          ...(fetch.sourceDigest === undefined ? {} : { sourceDigest: fetch.sourceDigest }),
          fetchedAtMs: fetch.fetchedAtMs,
        },
        health: healthOf(fetch, probe),
      });
    });

  const readEvidence: ForgeSourceReadsShape["readEvidence"] = (evidenceId) =>
    store.readObservations(evidenceId);

  const captureHistoricalWindow: ForgeSourceReadsShape["captureHistoricalWindow"] = ({
    environmentId,
    startedAt,
    endedAt,
  }) =>
    Effect.gen(function* () {
      if (startedAt >= endedAt) {
        return unavailableCapture("window start must be before window end");
      }
      if (endedAt - startedAt > FORGE_MAX_WINDOW_SECONDS) {
        return unavailableCapture(
          `historical window exceeds the 24h (${FORGE_MAX_WINDOW_SECONDS}s) bound`,
        );
      }
      const capturedAtMs = yield* Clock.currentTimeMillis;
      // One probe, one pin, every pool: the retained window describes a
      // single chain state.
      const result = yield* source.fetchAllPools({ startedAt, endedAt, historical: true });
      const servable = result.fetches.filter((fetch) => fetch.status !== "unavailable");
      if (servable.length === 0) {
        const first = result.fetches[0];
        return unavailableCapture(first?.reason ?? "no pool could be captured");
      }
      const pools: Array<{
        readonly poolId: string;
        readonly evidenceId: string;
        readonly observationCount: number;
        readonly anchorCoverage: "covered" | "missing";
      }> = [];
      for (const fetch of servable) {
        if (fetch.pinnedBlock === undefined || fetch.sourceDigest === undefined) continue;
        const observations: ReadonlyArray<ForgeSwapObservation> = fetch.observations ?? [];
        // Deterministic id: the same environment/window/pin/digest always
        // names the same evidence, so a retried capture upserts instead of
        // forking the trail.
        const evidenceId = `forge_ev_${NodeCrypto.createHash("sha256")
          .update(
            `${environmentId}:${fetch.poolId}:${fetch.pinnedBlock}:${startedAt}:${endedAt}:${fetch.sourceDigest}`,
          )
          .digest("hex")
          .slice(0, 24)}`;
        yield* store.insert({
          record: {
            evidenceId,
            environmentId,
            poolId: fetch.poolId,
            historical: true,
            endpoint: settingsEndpoint(yield* source.settings),
            deployment: fetch.deployment ?? "",
            pinnedBlock: fetch.pinnedBlock,
            ...(fetch.pinnedBlockHash === undefined
              ? {}
              : { pinnedBlockHash: fetch.pinnedBlockHash }),
            windowStart: startedAt,
            windowEnd: endedAt,
            fetchedAtMs: fetch.fetchedAtMs,
            digest: fetch.sourceDigest,
            observationCount: observations.length,
          },
          observations,
        });
        pools.push({
          poolId: fetch.poolId,
          evidenceId,
          observationCount: observations.length,
          anchorCoverage: fetch.anchorCoverage ?? "missing",
        });
      }
      const pinnedBlock = result.pinnedBlock ?? servable[0]?.pinnedBlock ?? 0;
      return okCapture({
        environmentId,
        pinnedBlock,
        window: { startedAt, endedAt },
        capturedAtMs,
        pools,
      });
    });

  return {
    listSources,
    readPoolSeries,
    readEvidence,
    captureHistoricalWindow,
  } satisfies ForgeSourceReadsShape;
});

/** The endpoint for provenance columns — credentials are never part of it. */
const settingsEndpoint = (settings: ForgeGraphSettings): string => settings.source?.endpoint ?? "";

/** Open about its two dependencies; the wiring point composes them. */
export const ForgeSourceReadsLive = Layer.effect(ForgeSourceReads, makeForgeSourceReads);
