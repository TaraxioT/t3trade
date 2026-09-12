// @effect-diagnostics preferSchemaOverJson:off - canonical serialization is hashed, never decoded as a domain value.
import { createHash } from "node:crypto";
import { Clock, Effect, Layer } from "effect";
import { ForgeGraphSource, FORGE_SWAPS_QUERY } from "./GraphSource.ts";
import { ForgeSourceStore } from "./ForgeSourceStore.ts";
import { ForgeSourceWindowProvider, forgeAggregatePoolWindow } from "./ForgeReactor.ts";

/** One source capture supplies every pool in an evaluation, with durable provenance. */
export const ForgeSourceWindowLive = Layer.effect(
  ForgeSourceWindowProvider,
  Effect.gen(function* () {
    const source = yield* ForgeGraphSource;
    const store = yield* ForgeSourceStore;
    return ForgeSourceWindowProvider.of({
      currentWindow: ({ environmentId }) =>
        Effect.gen(function* () {
          const settings = yield* source.settings;
          if (!settings.configured || settings.source === undefined)
            return yield* Effect.fail({
              reason: settings.reason ?? "Forge source is not configured",
            });
          const now = yield* Clock.currentTimeMillis;
          const endedAt = Math.floor(now / 1000);
          const startedAt = endedAt - 300;
          const capture = yield* source.fetchAllPools({ startedAt, endedAt });
          if (capture.fetches.length === 0 || capture.pinnedBlock === null)
            return yield* Effect.fail({ reason: "no pinned Forge source window" });
          const hashes = new Set(capture.fetches.map((fetch) => fetch.pinnedBlockHash));
          const blockHash = capture.fetches[0]?.pinnedBlockHash;
          if (hashes.size !== 1 || blockHash === undefined)
            return yield* Effect.fail({ reason: "pool block hashes do not agree" });
          const pools = [];
          const evidenceIds: string[] = [];
          for (const fetch of capture.fetches) {
            if (
              (fetch.status !== "complete" && fetch.status !== "empty") ||
              fetch.sourceDigest === undefined ||
              fetch.pinnedBlock !== capture.pinnedBlock
            ) {
              return yield* Effect.fail({ reason: fetch.reason ?? "incomplete source capture" });
            }
            const observations = fetch.observations ?? [];
            const anchors = fetch.anchorCandidates ?? [];
            const anchor = [...anchors].sort(
              (a, b) => a.ageBeforeWindowSeconds - b.ageBeforeWindowSeconds,
            )[0];
            pools.push(
              forgeAggregatePoolWindow({
                poolId: fetch.poolId,
                observations,
                anchorCandidates: anchors.map((item) => item.observation),
                ...(anchor === undefined
                  ? {}
                  : {
                      anchor: {
                        observationId: anchor.observation.observationId,
                        priceQuotePerBaseMicros: anchor.observation.priceQuotePerBaseMicros,
                        ageBeforeWindowSeconds: anchor.ageBeforeWindowSeconds,
                      },
                    }),
              }),
            );
            const evidenceId = `fsrc_${createHash("sha256")
              .update(JSON.stringify([environmentId, fetch.poolId, fetch.sourceDigest]))
              .digest("hex")}`;
            const retained = [...anchors.map((item) => item.observation), ...observations];
            yield* store
              .insert({
                record: {
                  evidenceId,
                  environmentId,
                  poolId: fetch.poolId,
                  historical: false,
                  endpoint: settings.source.endpoint,
                  deployment: settings.source.deployment,
                  pinnedBlock: capture.pinnedBlock,
                  pinnedBlockHash: blockHash,
                  windowStart: startedAt,
                  windowEnd: endedAt,
                  fetchedAtMs: fetch.fetchedAtMs,
                  digest: fetch.sourceDigest,
                  observationCount: retained.length,
                },
                observations: retained,
              })
              .pipe(Effect.mapError(() => ({ reason: "could not retain source evidence" })));
            evidenceIds.push(evidenceId);
          }
          const digest = createHash("sha256")
            .update(JSON.stringify(capture.fetches.map((fetch) => fetch.sourceDigest)))
            .digest("hex");
          return {
            evidence: {
              mode: "live" as const,
              provider: "the-graph" as const,
              deploymentId: settings.source.deployment,
              blockNumber: String(capture.pinnedBlock),
              blockHash,
              fetchedAtMs: now,
              windowEndMs: endedAt * 1000,
              querySha256: createHash("sha256").update(FORGE_SWAPS_QUERY).digest("hex"),
              responseSha256: digest,
              complete: true,
            },
            pools,
            evidenceIds,
            window: { startedAtMs: startedAt * 1000, endedAtMs: endedAt * 1000 },
            historical: false,
            pinnedBlock: capture.pinnedBlock,
            sourceDigest: digest,
          };
        }),
    });
  }),
);
