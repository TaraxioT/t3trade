/**
 * SubstreamsIngestion — the typed server-side stream consumer that turns a
 * provider stream into committed store state.
 *
 * The division of labor is strict:
 *
 * - The STREAM CLIENT (injected, `SubstreamsStreamClient`) owns the provider
 *   protocol: it opens ONE connection for an identical source specification,
 *   requests FINAL BLOCKS ONLY, decodes the package's protobuf output into
 *   the normalized records here, and surfaces undos. It receives no signer
 *   and no raw token — only the NAME of an environment variable the host
 *   resolves. The production adapter over the official `@substreams/core`
 *   library ships separately (worker-a-progress.md PROPOSAL 5); this service
 *   and its tests run against the interface alone.
 * - THIS SERVICE owns durability policy: bounded buffers (16 MiB buffered
 *   payload, at most 100 block envelopes per transaction), atomic
 *   batch-flush through SubstreamsSourceStore.commitBatch (facts +
 *   canonical projection + outbox + cursor in ONE transaction),
 *   duplicate-safe replay, and the fail-closed outcomes — an undo in
 *   final-blocks-only mode marks the source UNHEALTHY and stops; a
 *   non-final block, an oversized single message, a validation failure, a
 *   sequence gap, or a committed-hash conflict refuses explicitly and marks
 *   the source stale or unhealthy. Nothing is silently dropped.
 *
 * When the stream stops abnormally the pending, uncommitted batch is simply
 * left uncommitted: the next run resumes from the committed cursor and the
 * provider replays those blocks duplicate-safely. One loop per source: a
 * second run against an already-active sourceId refuses, so identical
 * specifications share one connection instead of racing two cursors.
 *
 * @module SubstreamsIngestion
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  SubstreamsSourceStore,
  type SubstreamsBlockInput,
  type SubstreamsPoolEventInput,
  type SubstreamsSourceIdentity,
} from "./SubstreamsSourceStore.ts";

// ---------------------------------------------------------------------------
// Bounds (05 gates: implementation guardrails, not throughput claims)
// ---------------------------------------------------------------------------

/** Buffered payload ceiling across pending block envelopes. */
export const SUBSTREAMS_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Most block envelopes committed in one database transaction. */
export const SUBSTREAMS_MAX_BLOCKS_PER_TRANSACTION = 100;
/** A single block message over this refuses explicitly. */
export const SUBSTREAMS_MAX_SINGLE_MESSAGE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The stream client interface (production adapter ships as PROPOSAL 5)
// ---------------------------------------------------------------------------

export interface SubstreamsStreamRequest {
  /** The built .spkg: local path or https URL. Identity is its sha256. */
  readonly packageRef: string;
  readonly network: string;
  readonly moduleName: string;
  readonly params: string;
  /** Resume point; null means start from `startBlock`. */
  readonly startCursor: string | null;
  readonly startBlock: string | null;
  readonly endpoint: string;
  /** NAME of the env var holding the provider token; never the token. */
  readonly tokenEnvName: string | null;
  readonly productionMode: boolean;
}

export interface SubstreamsStreamMessageBlock {
  readonly type: "block";
  readonly cursor: string;
  /** The provider's own finality verdict for this block. */
  readonly final: boolean;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly timestampMs: number;
  readonly events: ReadonlyArray<SubstreamsPoolEventInput>;
}

/** A sink-driven refusal: the ingestion loop decided the stream must stop. */
export type SubstreamsSinkFailure =
  | { readonly kind: "undo"; readonly reason: string }
  | { readonly kind: "non_final_block"; readonly reason: string }
  | { readonly kind: "oversized_message"; readonly reason: string }
  | { readonly kind: "commit_refused"; readonly reason: string }
  | { readonly kind: "persistence"; readonly reason: string };

export interface SubstreamsStreamSink {
  readonly onBlock: (
    message: SubstreamsStreamMessageBlock,
  ) => Effect.Effect<void, SubstreamsSinkFailure>;
  readonly onUndo: (message: {
    readonly lastValidCursor: string;
  }) => Effect.Effect<void, SubstreamsSinkFailure>;
}

export interface SubstreamsStreamClientShape {
  /**
   * Consume the stream, invoking the sink per message. Completes when the
   * stream ends (stop block reached or provider closed); fails with the
   * sink's structured refusal (propagated unchanged) or a redacted
   * provider-side reason string. Final-blocks-only is part of the client
   * contract: every delivered block message carries the provider's own
   * finality verdict.
   */
  readonly consume: (input: {
    readonly request: SubstreamsStreamRequest;
    readonly sink: SubstreamsStreamSink;
  }) => Effect.Effect<void, SubstreamsSinkFailure | string>;
}

export class SubstreamsStreamClient extends Context.Service<
  SubstreamsStreamClient,
  SubstreamsStreamClientShape
>()("t3/trading/forge/SubstreamsIngestion/SubstreamsStreamClient") {}

// ---------------------------------------------------------------------------
// Failures and summary
// ---------------------------------------------------------------------------

export type SubstreamsIngestionFailure =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "stream_error"; readonly reason: string }
  | { readonly kind: "oversized_message"; readonly reason: string }
  | { readonly kind: "non_final_block"; readonly reason: string }
  | { readonly kind: "undo"; readonly reason: string }
  | { readonly kind: "commit_refused"; readonly reason: string }
  | { readonly kind: "persistence"; readonly reason: string };

export interface SubstreamsIngestionSummary {
  readonly sourceId: string;
  readonly batchesCommitted: number;
  readonly blocksCommitted: number;
  readonly blocksReplayed: number;
  readonly lastCursor: string | null;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface SubstreamsIngestionShape {
  /**
   * Register (idempotently) and run one source to stream exhaustion or a
   * fail-closed outcome. `startBlock` seeds the first-ever run only; resume
   * always continues from the committed cursor. A source marked unhealthy
   * refuses to start: it blocks new actions until reconciled.
   */
  readonly run: (input: {
    readonly identity: SubstreamsSourceIdentity;
    readonly endpoint: string;
    readonly packageRef: string;
    readonly tokenEnvName: string | null;
    readonly startBlock: string | null;
    readonly productionMode: boolean;
    /**
     * Wall-clock supplier so tests are deterministic. Absent in production:
     * the loop then reads the Clock service at each use site.
     */
    readonly now?: (() => number) | undefined;
  }) => Effect.Effect<SubstreamsIngestionSummary, SubstreamsIngestionFailure | PersistenceSqlError>;
}

export class SubstreamsIngestion extends Context.Service<
  SubstreamsIngestion,
  SubstreamsIngestionShape
>()("t3/trading/forge/SubstreamsIngestion") {}

const messageApproxBytes = (message: SubstreamsStreamMessageBlock): number => {
  // Host-side payload approximation for buffer accounting: the normalized
  // fields' serialized length.
  let bytes = 96; // envelope fields
  for (const event of message.events) {
    bytes +=
      event.transactionHash.length +
      event.pool.length +
      event.sender.length +
      event.recipient.length +
      event.amount0Raw.length +
      event.amount1Raw.length +
      event.sqrtPriceX96.length +
      32;
  }
  return bytes;
};

/** Narrow a squashed cause into the public failure union; unknowns become
 * named stream errors, never silent successes. */
const toIngestionFailure = (error: unknown): SubstreamsIngestionFailure => {
  if (typeof error === "string") return { kind: "stream_error", reason: error };
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = (error as { readonly kind: unknown }).kind;
    if (
      kind === "undo" ||
      kind === "non_final_block" ||
      kind === "oversized_message" ||
      kind === "commit_refused" ||
      kind === "persistence" ||
      kind === "refused" ||
      kind === "stream_error"
    ) {
      return error as SubstreamsIngestionFailure;
    }
  }
  return { kind: "stream_error", reason: error instanceof Error ? error.message : String(error) };
};

interface PendingBatch {
  readonly blocks: ReadonlyArray<SubstreamsBlockInput>;
  readonly bytes: number;
  readonly lastCursor: string;
}

export const makeSubstreamsIngestion = Effect.gen(function* () {
  const store = yield* SubstreamsSourceStore;
  const client = yield* SubstreamsStreamClient;
  // One active loop per sourceId: identical specs share one connection.
  const active = new Set<string>();

  const run: SubstreamsIngestionShape["run"] = ({
    identity,
    endpoint,
    packageRef,
    tokenEnvName,
    startBlock,
    productionMode,
    now,
  }) =>
    Effect.gen(function* () {
      const registered = yield* store.ensureSource({
        identity,
        now: now === undefined ? yield* Clock.currentTimeMillis : now(),
      });
      const sourceId = registered.sourceId;
      if (active.has(sourceId)) {
        return yield* Effect.fail({
          kind: "refused",
          reason:
            "a stream for this source is already active (one connection per identical source specification)",
        } satisfies SubstreamsIngestionFailure);
      }
      active.add(sourceId);
      return yield* Effect.gen(function* () {
        const resume = yield* store.resumeCursor(identity.environmentId, sourceId);
        if (resume === null) {
          return yield* Effect.fail({
            kind: "refused",
            reason: "the source row vanished during startup",
          } satisfies SubstreamsIngestionFailure);
        }
        if (resume.state === "unhealthy") {
          return yield* Effect.fail({
            kind: "refused",
            reason:
              "the source is marked unhealthy (an undo or a committed-hash conflict in final-blocks-only mode); it blocks new actions until reconciled",
          } satisfies SubstreamsIngestionFailure);
        }
        const startCursor = resume.cursor;
        if (startCursor === null && startBlock === null) {
          return yield* Effect.fail({
            kind: "refused",
            reason: "no committed cursor exists and no startBlock was supplied",
          } satisfies SubstreamsIngestionFailure);
        }

        const emptyBatch: PendingBatch = { blocks: [], bytes: 0, lastCursor: "" };
        let pending = emptyBatch;
        let batchesCommitted = 0;
        let blocksCommitted = 0;
        let blocksReplayed = 0;

        const flush = (): Effect.Effect<void, SubstreamsIngestionFailure | PersistenceSqlError> =>
          Effect.gen(function* () {
            if (pending.blocks.length === 0) return;
            const outcome = yield* store.commitBatch({
              sourceId,
              environmentId: identity.environmentId,
              blocks: pending.blocks,
              cursor: pending.lastCursor,
              now: now === undefined ? yield* Clock.currentTimeMillis : now(),
            });
            pending = emptyBatch;
            if (outcome.status === "committed") {
              batchesCommitted += 1;
              blocksCommitted += outcome.blocks - outcome.replayed;
              blocksReplayed += outcome.replayed;
              yield* Effect.logInfo("SubstreamsIngestion: batch committed", {
                sourceId,
                blocks: outcome.blocks,
                replayed: outcome.replayed,
                batches: batchesCommitted,
              });
              return;
            }
            const detail = `commit refused (${outcome.status}): ${outcome.reason}`;
            if (outcome.status === "conflict" || outcome.status === "invalid") {
              yield* store
                .markUnhealthy({
                  environmentId: identity.environmentId,
                  sourceId,
                  reason: detail,
                })
                .pipe(
                  Effect.mapError((failure): SubstreamsIngestionFailure => ({
                    kind: "persistence",
                    reason: `persistence failure marking the source unhealthy: ${String(failure)}`,
                  })),
                );
            } else {
              yield* store
                .markStale({
                  environmentId: identity.environmentId,
                  sourceId,
                  reason: detail,
                })
                .pipe(
                  Effect.mapError((failure): SubstreamsIngestionFailure => ({
                    kind: "persistence",
                    reason: `persistence failure marking the source stale: ${String(failure)}`,
                  })),
                );
            }
            return yield* Effect.fail({
              kind: "commit_refused",
              reason: detail,
            } satisfies SubstreamsIngestionFailure);
          });

        const consumed = yield* Effect.exit(
          client.consume({
            request: {
              packageRef,
              network: identity.network,
              moduleName: identity.moduleName,
              params: identity.params,
              startCursor,
              startBlock,
              endpoint,
              tokenEnvName,
              productionMode,
            },
            sink: {
              onBlock: (message) =>
                Effect.gen(function* () {
                  if (!message.final) {
                    yield* store
                      .markStale({
                        environmentId: identity.environmentId,
                        sourceId,
                        reason:
                          "the provider delivered a non-final block in final-blocks-only mode",
                      })
                      .pipe(
                        Effect.mapError((failure): SubstreamsSinkFailure => ({
                          kind: "persistence",
                          reason: `persistence failure marking the source stale: ${String(failure)}`,
                        })),
                      );
                    return yield* Effect.fail({
                      kind: "non_final_block",
                      reason:
                        "non-final block delivered in final-blocks-only mode; consumption stopped",
                    } satisfies SubstreamsSinkFailure);
                  }
                  const approxBytes = messageApproxBytes(message);
                  if (approxBytes > SUBSTREAMS_MAX_SINGLE_MESSAGE_BYTES) {
                    yield* store
                      .markStale({
                        environmentId: identity.environmentId,
                        sourceId,
                        reason: `a single block message was ~${approxBytes} bytes, over the ${SUBSTREAMS_MAX_SINGLE_MESSAGE_BYTES}-byte single-message cap; refused explicitly, nothing dropped silently`,
                      })
                      .pipe(
                        Effect.mapError((failure): SubstreamsSinkFailure => ({
                          kind: "persistence",
                          reason: `persistence failure marking the source stale: ${String(failure)}`,
                        })),
                      );
                    return yield* Effect.fail({
                      kind: "oversized_message",
                      reason: `single block message ~${approxBytes} bytes exceeds the ${SUBSTREAMS_MAX_SINGLE_MESSAGE_BYTES}-byte cap`,
                    } satisfies SubstreamsSinkFailure);
                  }
                  const block: SubstreamsBlockInput = {
                    number: message.blockNumber,
                    hash: message.blockHash,
                    timestampMs: message.timestampMs,
                    events: message.events,
                  };
                  if (blocksCommitted === 0 && pending.blocks.length === 0) {
                    // The lane's heartbeat: a run that connects but never
                    // logs this is stuck between the transport and the first
                    // provider message — visible immediately, not after the
                    // reconnect timeout.
                    yield* Effect.logInfo("SubstreamsIngestion: first block buffered", {
                      sourceId,
                      blockNumber: message.blockNumber,
                      blockHash: message.blockHash,
                      events: message.events.length,
                    });
                  }
                  pending = {
                    blocks: [...pending.blocks, block],
                    bytes: pending.bytes + approxBytes,
                    lastCursor: message.cursor,
                  };
                  if (
                    pending.blocks.length >= SUBSTREAMS_MAX_BLOCKS_PER_TRANSACTION ||
                    pending.bytes >= SUBSTREAMS_MAX_BUFFERED_BYTES
                  ) {
                    return yield* flush().pipe(
                      Effect.mapError((failure): SubstreamsSinkFailure =>
                        "kind" in failure && failure.kind === "commit_refused"
                          ? failure
                          : {
                              kind: "persistence",
                              reason: `persistence failure during commit: ${String(failure)}`,
                            },
                      ),
                    );
                  }
                }),
              onUndo: ({ lastValidCursor }) =>
                Effect.gen(function* () {
                  // Final-blocks-only: an undo here means a reorg reached
                  // past committed finality. Fail closed — mark unhealthy
                  // (which blocks new actions) and stop consuming. The
                  // pending uncommitted batch is left for replay.
                  yield* store
                    .markUnhealthy({
                      environmentId: identity.environmentId,
                      sourceId,
                      reason: `unexpected undo signal in final-blocks-only mode; last valid cursor ${lastValidCursor}`,
                    })
                    .pipe(
                      Effect.mapError((failure): SubstreamsSinkFailure => ({
                        kind: "persistence",
                        reason: `persistence failure marking the source unhealthy: ${String(failure)}`,
                      })),
                    );
                  return yield* Effect.fail({
                    kind: "undo",
                    reason: `undo signal in final-blocks-only mode (last valid cursor ${lastValidCursor})`,
                  } satisfies SubstreamsSinkFailure);
                }),
            },
          }),
        );

        if (consumed._tag === "Failure") {
          // Sink refusals already marked health; a provider-side string is a
          // stream error that leaves the source healthy-but-reconnecting
          // (stale only if it persists — the wiring layer owns backoff).
          return yield* Effect.fail(toIngestionFailure(Cause.squash(consumed.cause)));
        }

        // Normal stream end: commit what is pending, then report.
        yield* flush();
        const resumeAfter = yield* store.resumeCursor(identity.environmentId, sourceId);
        return {
          sourceId,
          batchesCommitted,
          blocksCommitted,
          blocksReplayed,
          lastCursor: resumeAfter?.cursor ?? null,
        } satisfies SubstreamsIngestionSummary;
      }).pipe(
        // Release the single-flight slot on ANY exit, success or failure.
        Effect.onExit(() =>
          Effect.sync(() => {
            active.delete(sourceId);
          }),
        ),
      );
    });

  return { run } satisfies SubstreamsIngestionShape;
});

export const SubstreamsIngestionLive = Layer.effect(SubstreamsIngestion, makeSubstreamsIngestion);
