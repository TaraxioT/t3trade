/**
 * SubstreamsIngestion — held to its durability policy against a scripted
 * stream client (the production @substreams/core adapter ships separately).
 *
 * Properties under test: batch flushing at the 100-block bound and the
 * 16 MiB buffered-payload bound, resume from the committed cursor,
 * duplicate-safe replay across runs, undo → unhealthy (and the refusal of a
 * next run until reconciled), non-final block → stale + explicit refusal,
 * oversized single message → explicit refusal, and single-flight per source.
 */
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import createSubstreamsTables from "../../persistence/Migrations/108_SubstreamsSources.ts";
import {
  SubstreamsSourceStore,
  makeSubstreamsSourceStore,
  type SubstreamsSourceIdentity,
  type SubstreamsSourceStoreShape,
} from "./SubstreamsSourceStore.ts";
import {
  SUBSTREAMS_MAX_BLOCKS_PER_TRANSACTION,
  SUBSTREAMS_MAX_BUFFERED_BYTES,
  SUBSTREAMS_MAX_SINGLE_MESSAGE_BYTES,
  SubstreamsStreamClient,
  makeSubstreamsIngestion,
  type SubstreamsStreamMessageBlock,
  type SubstreamsStreamRequest,
  type SubstreamsStreamClientShape,
} from "./SubstreamsIngestion.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

const PACKAGE_SHA = "b".repeat(64);
const ENDPOINT = "https://substreams.example.invalid";

const identity = (environmentId: string): SubstreamsSourceIdentity => ({
  environmentId,
  chainId: "1",
  network: "mainnet",
  packageSha256: PACKAGE_SHA,
  moduleName: "map_pool_blocks",
  params: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  schemaVersion: 1,
});

interface BlockScript {
  readonly number: number;
  readonly eventCount?: number;
  readonly final?: boolean;
  readonly hash?: string;
  readonly approxBytes?: number;
}

const message = (
  script: BlockScript,
  cursorOf: (n: number) => string,
): SubstreamsStreamMessageBlock => ({
  type: "block",
  cursor: cursorOf(script.number),
  final: script.final ?? true,
  blockNumber: String(script.number),
  blockHash:
    script.hash ??
    "0x" + Buffer.from(`block-${script.number}`).toString("hex").padEnd(64, "0").slice(0, 64),
  timestampMs: 1_700_000_000_000 + script.number * 12_000,
  events: Array.from({ length: script.eventCount ?? 0 }, (_, index) => ({
    transactionHash:
      "0x" +
      Buffer.from(`tx-${script.number}-${index}`).toString("hex").padEnd(64, "0").slice(0, 64),
    logIndex: index,
    pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    amount0Raw: index % 2 === 0 ? "1000" : "-2000",
    amount1Raw: index % 2 === 0 ? "-2000" : "1000",
    sqrtPriceX96: "1".repeat(30),
    sender: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
    recipient: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
  })),
});

interface ScriptedStream {
  readonly blocks: ReadonlyArray<BlockScript>;
  readonly undoAfter?: number;
  /** Extra padding bytes added to every block's buffer accounting. */
  readonly padBytes?: number;
}

/** A deterministic scripted client: yields blocks in order, then undoes. */
const scriptedClient = (script: ScriptedStream) => {
  const seenRequests: Array<SubstreamsStreamRequest> = [];
  const shape: SubstreamsStreamClientShape = {
    consume: ({ request, sink }) =>
      Effect.gen(function* () {
        seenRequests.push(request);
        let index = 0;
        for (const blockScript of script.blocks) {
          const base = message(blockScript, (n) => `cursor-${n}`);
          const padded: SubstreamsStreamMessageBlock =
            script.padBytes === undefined
              ? base
              : {
                  ...base,
                  events: [
                    ...base.events,
                    // A synthetic oversized-but-valid decimal string pads the
                    // payload accounting without breaking field validation.
                    {
                      transactionHash: base.events[0]?.transactionHash ?? "0x" + "aa".repeat(32),
                      logIndex: 500 + index,
                      pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
                      amount0Raw: "1",
                      amount1Raw: "1",
                      sqrtPriceX96: "9".repeat(Math.max(script.padBytes - 40, 0)),
                      sender: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                      recipient: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                    },
                  ],
                };
          yield* sink.onBlock(padded);
          index += 1;
          if (script.undoAfter !== undefined && index >= script.undoAfter) break;
        }
        if (script.undoAfter !== undefined) {
          return yield* sink.onUndo({ lastValidCursor: "cursor-early" });
        }
      }),
  };
  return { shape, seenRequests };
};

interface Harness {
  readonly store: SubstreamsSourceStoreShape;
  readonly run: (
    clientShape: SubstreamsStreamClientShape,
    environmentId: string,
    input?: { readonly startBlock?: string | null },
  ) => Effect.Effect<
    import("./SubstreamsIngestion.ts").SubstreamsIngestionSummary,
    | import("./SubstreamsIngestion.ts").SubstreamsIngestionFailure
    | import("../../persistence/Errors.ts").PersistenceSqlError
  >;
}

// One ingestion service instance per harness, behind a delegating client the
// test re-points per run — an inner provideService cannot be overridden from
// the outside, and the single-flight property needs ONE service instance.
const makeHarness = (
  initial: SubstreamsStreamClientShape,
): Effect.Effect<Harness, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const store = yield* makeSubstreamsSourceStore;
    const holder: { shape: SubstreamsStreamClientShape } = { shape: initial };
    const delegating: SubstreamsStreamClientShape = {
      consume: (input) => holder.shape.consume(input),
    };
    const ingestion = yield* makeSubstreamsIngestion.pipe(
      Effect.provideService(SubstreamsSourceStore, SubstreamsSourceStore.of(store)),
      Effect.provideService(SubstreamsStreamClient, SubstreamsStreamClient.of(delegating)),
    );
    return {
      store,
      run: (shape, environmentId, input) => {
        holder.shape = shape;
        return ingestion.run({
          identity: identity(environmentId),
          endpoint: ENDPOINT,
          packageRef: "/packages/pool-observations.spkg",
          tokenEnvName: "SUBSTREAMS_API_TOKEN",
          startBlock: input?.startBlock ?? "1000",
          productionMode: true,
          now: () => 5_000,
        });
      },
    };
  });

/** Narrow a flipped failure to the ingestion union; persistence errors fail
 * the test loudly instead of being misread. */
const ingestionFailure = (
  failure:
    | import("./SubstreamsIngestion.ts").SubstreamsIngestionFailure
    | import("../../persistence/Errors.ts").PersistenceSqlError,
): import("./SubstreamsIngestion.ts").SubstreamsIngestionFailure => {
  if (!("kind" in failure)) {
    throw new Error(`unexpected persistence failure: ${String(failure)}`);
  }
  return failure;
};

const countBlocks = (store: SubstreamsSourceStoreShape, environmentId: string, sourceId: string) =>
  store.readBlockEnvelopes({ environmentId, sourceId, fromBlock: "0", toBlock: "999999999" });

layer("SubstreamsIngestion commit policy", (it) => {
  it.effect("flushes at the 100-block transaction bound and commits zero-swap envelopes", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      const client = scriptedClient({
        blocks: Array.from({ length: 150 }, (_, index) => ({
          number: 1000 + index,
          eventCount: index % 50 === 0 ? 2 : 0,
        })),
      });
      const harness = yield* makeHarness(client.shape);
      const summary = yield* harness.run(client.shape, "env_ing_bounds");
      const { sourceId } = yield* harness.store.ensureSource({
        identity: identity("env_ing_bounds"),
        now: 1,
      });
      assert.equal(summary.sourceId, sourceId);
      assert.equal(summary.batchesCommitted, 2);
      assert.equal(summary.blocksCommitted, 150);
      assert.equal(summary.blocksReplayed, 0);
      assert.equal(summary.lastCursor, "cursor-1149");
      const envelopes = yield* countBlocks(harness.store, "env_ing_bounds", sourceId);
      assert.equal(envelopes.blocks.length, 150);
      // Zero-swap blocks are committed: empty intervals are provable.
      assert.equal(envelopes.blocks[1]?.eventCount, 0);
      assert.equal(envelopes.blocks[0]?.eventCount, 2);
      const health = yield* harness.store.sourceHealth("env_ing_bounds", sourceId);
      assert.equal(health.state, "healthy");
      assert.equal(health.finalWatermarkBlock, "1149");
    }),
  );

  it.effect("flushes on the 16 MiB buffered-payload bound before 100 blocks accumulate", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      // 3 blocks x ~6 MiB: under the single-message cap, over the buffer
      // bound together. The 4th never exists; the bound flushes after block 3.
      const perBlock = Math.ceil(SUBSTREAMS_MAX_BUFFERED_BYTES / 3) + 100;
      const client = scriptedClient({
        blocks: [{ number: 2000 }, { number: 2001 }, { number: 2002 }, { number: 2003 }],
        padBytes: perBlock,
      });
      const harness = yield* makeHarness(client.shape);
      const summary = yield* harness.run(client.shape, "env_ing_bytes");
      assert.equal(summary.batchesCommitted, 2); // flush after 3 blocks, flush at end
      assert.equal(summary.blocksCommitted, 4);
      const { sourceId } = yield* harness.store.ensureSource({
        identity: identity("env_ing_bytes"),
        now: 1,
      });
      const envelopes = yield* countBlocks(harness.store, "env_ing_bytes", sourceId);
      assert.equal(envelopes.blocks.length, 4);
    }),
  );

  it.effect(
    "resumes from the committed cursor and replays a duplicate batch safely across runs",
    () =>
      Effect.gen(function* () {
        yield* createSubstreamsTables;
        const blocks = Array.from({ length: 5 }, (_, index) => ({
          number: 3000 + index,
          eventCount: index === 2 ? 1 : 0,
        }));
        const first = scriptedClient({ blocks });
        const harness = yield* makeHarness(first.shape);
        const firstSummary = yield* harness.run(first.shape, "env_ing_resume");
        assert.equal(firstSummary.blocksCommitted, 5);
        // The provider replays the last committed block plus the new ones —
        // the classic crash-after-commit duplicate.
        const second = scriptedClient({
          blocks: [...blocks.slice(3), { number: 3005 }, { number: 3006 }],
        });
        const secondSummary = yield* harness.run(second.shape, "env_ing_resume");
        assert.equal(secondSummary.blocksReplayed, 2);
        assert.equal(secondSummary.blocksCommitted, 2);
        // The second run's request carried the committed cursor, not startBlock.
        const resumeRequest = second.seenRequests[0];
        assert.equal(resumeRequest?.startCursor, "cursor-3004");
        const { sourceId } = yield* harness.store.ensureSource({
          identity: identity("env_ing_resume"),
          now: 1,
        });
        const envelopes = yield* countBlocks(harness.store, "env_ing_resume", sourceId);
        assert.equal(envelopes.blocks.length, 7);
        const health = yield* harness.store.sourceHealth("env_ing_resume", sourceId);
        assert.equal(health.finalWatermarkBlock, "3006");
      }),
  );

  it.effect(
    "undo in final-blocks-only mode marks the source unhealthy and blocks the next run",
    () =>
      Effect.gen(function* () {
        yield* createSubstreamsTables;
        const client = scriptedClient({
          blocks: [{ number: 4000, eventCount: 1 }, { number: 4001 }],
          undoAfter: 2,
        });
        const harness = yield* makeHarness(client.shape);
        const failure = ingestionFailure(
          yield* Effect.flip(harness.run(client.shape, "env_ing_undo")),
        );
        assert.equal(failure.kind, "undo");
        const { sourceId } = yield* harness.store.ensureSource({
          identity: identity("env_ing_undo"),
          now: 1,
        });
        const health = yield* harness.store.sourceHealth("env_ing_undo", sourceId);
        assert.equal(health.state, "unhealthy");
        assert.match(health.reason, /undo signal in final-blocks-only mode/);
        // The pending batch never committed (abnormal stop): nothing landed,
        // and the run refuses to restart while unhealthy.
        const envelopes = yield* countBlocks(harness.store, "env_ing_undo", sourceId);
        assert.equal(envelopes.blocks.length, 0);
        const retry = ingestionFailure(
          yield* Effect.flip(
            harness.run(scriptedClient({ blocks: [{ number: 4002 }] }).shape, "env_ing_undo"),
          ),
        );
        assert.equal(retry.kind, "refused");
        assert.match(retry.reason, /marked unhealthy/);
        void sourceId;
      }),
  );

  it.effect("a non-final block refuses explicitly and marks the source stale", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      const client = scriptedClient({
        blocks: [{ number: 5000 }, { number: 5001, final: false }],
      });
      const harness = yield* makeHarness(client.shape);
      const failure = ingestionFailure(
        yield* Effect.flip(harness.run(client.shape, "env_ing_nonfinal")),
      );
      assert.equal(failure.kind, "non_final_block");
      const health = yield* harness.store.sourceHealth(
        "env_ing_nonfinal",
        (yield* harness.store.ensureSource({ identity: identity("env_ing_nonfinal"), now: 1 }))
          .sourceId,
      );
      assert.equal(health.state, "stale");
      assert.match(health.reason, /non-final block/);
      // The pending uncommitted block did NOT land.
      const envelopes = yield* countBlocks(
        harness.store,
        "env_ing_nonfinal",
        (yield* harness.store.ensureSource({ identity: identity("env_ing_nonfinal"), now: 1 }))
          .sourceId,
      );
      assert.equal(envelopes.blocks.length, 0);
    }),
  );

  it.effect("an oversized single message refuses explicitly and is never dropped silently", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      const client = scriptedClient({
        blocks: [{ number: 6000 }],
        padBytes: SUBSTREAMS_MAX_SINGLE_MESSAGE_BYTES + 100,
      });
      const harness = yield* makeHarness(client.shape);
      const failure = ingestionFailure(
        yield* Effect.flip(harness.run(client.shape, "env_ing_oversize")),
      );
      assert.equal(failure.kind, "oversized_message");
      assert.match(failure.reason, /exceeds the/);
    }),
  );

  it.effect("one connection per identical source: a concurrent second run refuses", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      // The held stream signals when the first run is inside it, then parks
      // on the gate — deterministic proof the connection is being held.
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const held: SubstreamsStreamClientShape = {
        consume: ({ sink }) =>
          Effect.gen(function* () {
            yield* sink.onBlock(message({ number: 7000 }, (n) => `cursor-${n}`));
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(gate);
          }),
      };
      const harness = yield* makeHarness(held);
      const first = yield* harness.run(held, "env_ing_single").pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      const second = ingestionFailure(yield* Effect.flip(harness.run(held, "env_ing_single")));
      assert.equal(second.kind, "refused");
      assert.match(second.reason, /already active/);
      yield* Deferred.succeed(gate, undefined);
      const firstOutcome = yield* Fiber.join(first);
      assert.equal(firstOutcome._tag, "Success");
      if (firstOutcome._tag === "Success") {
        assert.equal(firstOutcome.value.blocksCommitted, 1);
      }
    }),
  );
});
