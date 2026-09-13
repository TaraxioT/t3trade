/**
 * SubstreamsSourceStore — held to its frozen contract.
 *
 * Real store over an in-memory SQLite database with the real 108 migration;
 * no provider, no network. The core properties under test: atomic
 * batch-commit (blocks + events + watermark + cursor + outbox), zero-swap
 * block envelopes as completeness proof, duplicate-safe replay,
 * fork-past-finality conflicts, sequence-gap refusal, whole-batch input
 * validation, and the health/revision/outbox reads Worker B consumes.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import createSubstreamsTables from "../../persistence/Migrations/108_SubstreamsSources.ts";
import {
  deriveModuleDigest,
  deriveSourceId,
  makeSubstreamsSourceStore,
  validateBlockInput,
  type SubstreamsBlockInput,
  type SubstreamsPoolEventInput,
  type SubstreamsSourceIdentity,
  type SubstreamsSourceStoreShape,
} from "./SubstreamsSourceStore.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

// The memory layer is built once per describe block: every test scopes its
// rows under its own environmentId so the per-source contiguity rule cannot
// leak between tests.
let envCounter = 0;
const envFor = (name: string): string => `env_sub_${name}_${(envCounter += 1)}`;
const PACKAGE_SHA = "a".repeat(64);

const identity = (
  environmentId: string,
  overrides?: Partial<SubstreamsSourceIdentity>,
): SubstreamsSourceIdentity => ({
  environmentId,
  chainId: "1",
  network: "mainnet",
  packageSha256: PACKAGE_SHA,
  moduleName: "map_pool_blocks",
  params: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  schemaVersion: 1,
  ...overrides,
});

const event = (overrides?: Partial<SubstreamsPoolEventInput>): SubstreamsPoolEventInput => ({
  transactionHash: "0x" + "ab".repeat(32),
  logIndex: 42,
  pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
  amount0Raw: "9290",
  amount1Raw: "-3677177486975",
  sqrtPriceX96: "157668859431".repeat(3),
  sender: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
  recipient: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
  ...overrides,
});

const block = (
  number: number,
  overrides?: Partial<SubstreamsBlockInput>,
): SubstreamsBlockInput => ({
  number: String(number),
  hash:
    "0x" +
    (number % 16 === 0
      ? "0".repeat(64)
      : Buffer.from(`block-${number}`).toString("hex").padEnd(64, "0")),
  timestampMs: 1_700_000_000_000 + number * 12_000,
  events: [],
  ...overrides,
});

const ensure = (
  store: SubstreamsSourceStoreShape,
  environmentId: string,
  overrides?: Partial<SubstreamsSourceIdentity>,
) => store.ensureSource({ identity: identity(environmentId, overrides), now: 1_000 });

const commit = (
  store: SubstreamsSourceStoreShape,
  environmentId: string,
  sourceId: string,
  blocks: ReadonlyArray<SubstreamsBlockInput>,
  cursor: string,
  now = 2_000,
) => store.commitBatch({ sourceId, environmentId, blocks, cursor, now });

it.effect("deriveModuleDigest namespaces module+params+schema, not just the module name", () =>
  Effect.sync(() => {
    const base = deriveModuleDigest({
      moduleName: "map_pool_blocks",
      params: "0xaa",
      schemaVersion: 1,
    });
    const changedParams = deriveModuleDigest({
      moduleName: "map_pool_blocks",
      params: "0xbb",
      schemaVersion: 1,
    });
    const changedSchema = deriveModuleDigest({
      moduleName: "map_pool_blocks",
      params: "0xaa",
      schemaVersion: 2,
    });
    assert.notEqual(base, changedParams);
    assert.notEqual(base, changedSchema);
  }),
);

it.effect(
  "validateBlockInput accepts the real fixture-derived record and refuses each corruption",
  () =>
    Effect.sync(() => {
      const good = validateBlockInput(block(25964737, { events: [event()] }));
      assert.equal(good, null);
      assert.match(validateBlockInput(block(1, { hash: "0XAB" })) ?? "", /hash/);
      assert.match(validateBlockInput({ ...block(1), number: "0x10" }) ?? "", /block number/);
      assert.match(
        validateBlockInput(block(1, { events: [event({ amount0Raw: "1.5" })] })) ?? "",
        /amount0Raw/,
      );
      assert.match(
        validateBlockInput(block(1, { events: [event({ pool: "0x1234" })] })) ?? "",
        /pool/,
      );
      assert.match(
        validateBlockInput(
          block(1, {
            events: [event({ logIndex: 1 }), event({ logIndex: 1 })],
          }),
        ) ?? "",
        /duplicates transaction\/log identity/,
      );
    }),
);

layer("SubstreamsSourceStore commit", (it) => {
  it.effect("ensureSource is idempotent and derives the same sourceId for the same identity", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      const store = yield* makeSubstreamsSourceStore;
      const env = envFor("ensure");
      const first = yield* ensure(store, env);
      const second = yield* ensure(store, env);
      assert.equal(first.sourceId, second.sourceId);
      const expected = deriveSourceId(identity(env), first.moduleDigest);
      assert.equal(first.sourceId, expected);
      // A different pool param namespace is a different source.
      const other = yield* store.ensureSource({
        identity: identity(env, { params: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8" }),
        now: 1_000,
      });
      assert.notEqual(other.sourceId, first.sourceId);
    }),
  );

  it.effect("commits blocks, events, watermark, cursor and one outbox row in one batch", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      const store = yield* makeSubstreamsSourceStore;
      const env = envFor("commit");
      const { sourceId } = yield* ensure(store, env);
      const outcome = yield* commit(
        store,
        env,
        sourceId,
        [
          block(100, { events: [event({ logIndex: 1 })] }),
          block(101),
          block(102, { events: [event({ logIndex: 2 })] }),
        ],
        "cursor-1",
      );
      assert.deepEqual(outcome, { status: "committed", sourceId, blocks: 3, replayed: 0 });

      const watermark = yield* store.committedWatermark(env, sourceId);
      assert.deepEqual(watermark, {
        finalWatermarkBlock: "102",
        finalWatermarkTimestampMs: block(102).timestampMs,
      });

      const envelopes = yield* store.readBlockEnvelopes({
        environmentId: env,
        sourceId,
        fromBlock: "100",
        toBlock: "102",
      });
      assert.equal(envelopes.blocks.length, 3);
      // The zero-swap block 101 is present: an empty interval is provable.
      assert.equal(envelopes.blocks[1]?.eventCount, 0);
      assert.equal(envelopes.blocks[0]?.eventCount, 1);

      const events = yield* store.readPoolEvents({
        environmentId: env,
        sourceId,
        fromBlock: "100",
        toBlock: "102",
      });
      assert.equal(events.length, 2);
      assert.equal(events[0]?.blockNumber, "100");
      assert.equal(events[0]?.amount1Raw, "-3677177486975");

      const health = yield* store.sourceHealth(env, sourceId);
      assert.equal(health.state, "healthy");
      assert.equal(health.cursor, "cursor-1");
      assert.equal(health.packageSha256, PACKAGE_SHA);
      assert.ok(health.moduleDigest.length === 64);

      const revision = yield* store.sourceRevision(env, sourceId);
      assert.equal(revision, `${PACKAGE_SHA}/${health.moduleDigest}`);

      const pending = yield* store.claimPendingOutbox({ environmentId: env, limit: 10 });
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.toBlockNum, 102);
      assert.equal(pending[0]?.processedAtMs, null);
      const acked = yield* store.ackOutbox({ outboxId: pending[0]!.outboxId, now: 3_000 });
      assert.equal(acked, true);
      const afterAck = yield* store.claimPendingOutbox({ environmentId: env, limit: 10 });
      assert.equal(afterAck.length, 0);
    }),
  );

  it.effect("replaying an identical batch is duplicate-safe and creates no second outbox row", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      const store = yield* makeSubstreamsSourceStore;
      const env = envFor("replay");
      const { sourceId } = yield* ensure(store, env);
      const blocks = [block(200, { events: [event()] }), block(201)];
      yield* commit(store, env, sourceId, blocks, "cursor-a");
      const replay = yield* commit(store, env, sourceId, blocks, "cursor-a", 2_500);
      assert.deepEqual(replay, { status: "committed", sourceId, blocks: 2, replayed: 2 });

      const sql = yield* SqlClient.SqlClient;
      const blockRows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM substreams_blocks WHERE source_id = ${sourceId}
      `;
      const eventRows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM substreams_pool_events WHERE environment_id = ${env}
      `;
      const outboxRows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM substreams_outbox WHERE source_id = ${sourceId}
      `;
      assert.equal(blockRows[0]?.n, 2);
      assert.equal(eventRows[0]?.n, 1);
      assert.equal(outboxRows[0]?.n, 1);
    }),
  );

  it.effect("refuses a batch that does not continue the committed watermark exactly", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      const store = yield* makeSubstreamsSourceStore;
      const env = envFor("gap");
      const { sourceId } = yield* ensure(store, env);
      yield* commit(store, env, sourceId, [block(300)], "cursor-a");
      const gap = yield* commit(store, env, sourceId, [block(302)], "cursor-b");
      assert.equal(gap.status, "gap");
      // Nothing advanced: the refused batch wrote nothing.
      const watermark = yield* store.committedWatermark(env, sourceId);
      assert.equal(watermark?.finalWatermarkBlock, "300");
      const health = yield* store.sourceHealth(env, sourceId);
      assert.equal(health.cursor, "cursor-a");
    }),
  );

  it.effect(
    "refuses a committed-number hash change as a fork past finality, and marks via the caller",
    () =>
      Effect.gen(function* () {
        yield* createSubstreamsTables;
        const store = yield* makeSubstreamsSourceStore;
        const env = envFor("conflict");
        const { sourceId } = yield* ensure(store, env);
        yield* commit(store, env, sourceId, [block(400, { events: [event()] })], "cursor-a");
        const conflict = yield* commit(
          store,
          env,
          sourceId,
          [block(400, { hash: "0x" + "cc".repeat(32) })],
          "cursor-b",
        );
        assert.equal(conflict.status, "conflict");
      }),
  );

  it.effect("refuses an invalid batch wholly: no partial rows survive", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      const store = yield* makeSubstreamsSourceStore;
      const env = envFor("invalid");
      const { sourceId } = yield* ensure(store, env);
      const outcome = yield* commit(
        store,
        env,
        sourceId,
        [block(500), block(501, { events: [event({ sqrtPriceX96: "not-a-number" })] })],
        "cursor-x",
      );
      assert.equal(outcome.status, "invalid");
      const envelopes = yield* store.readBlockEnvelopes({
        environmentId: env,
        sourceId,
        fromBlock: "500",
        toBlock: "501",
      });
      assert.equal(envelopes.blocks.length, 0);
    }),
  );

  it.effect(
    "health transitions: stale marks, unhealthy absorbs, unknown sources report honestly",
    () =>
      Effect.gen(function* () {
        yield* createSubstreamsTables;
        const store = yield* makeSubstreamsSourceStore;
        const env = envFor("health");
        const { sourceId } = yield* ensure(store, env);
        const stale = yield* store.markStale({
          environmentId: env,
          sourceId,
          reason: "provider unavailable",
        });
        assert.equal(stale, true);
        const unhealthy = yield* store.markUnhealthy({
          environmentId: env,
          sourceId,
          reason: "undo signal",
        });
        assert.equal(unhealthy, true);
        // Stale cannot downgrade an unhealthy source.
        const downgrade = yield* store.markStale({
          environmentId: env,
          sourceId,
          reason: "late stale attempt",
        });
        assert.equal(downgrade, false);
        const health = yield* store.sourceHealth(env, sourceId);
        assert.equal(health.state, "unhealthy");
        assert.equal(health.reason, "undo signal");

        const unknown = yield* store.sourceHealth(env, "sub_unknown");
        assert.equal(unknown.state, "unhealthy");
        assert.match(unknown.reason, /no substreams source/);
        assert.equal(unknown.finalWatermarkBlock, "0");
      }),
  );

  it.effect("readPoolEvents is scoped to the source's module digest, never another namespace", () =>
    Effect.gen(function* () {
      yield* createSubstreamsTables;
      const store = yield* makeSubstreamsSourceStore;
      const env = envFor("scope");
      const first = yield* ensure(store, env);
      const second = yield* store.ensureSource({
        identity: identity(env, { params: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8" }),
        now: 1_000,
      });
      yield* commit(store, env, first.sourceId, [block(600, { events: [event()] })], "cursor-a");
      yield* commit(
        store,
        env,
        second.sourceId,
        [block(600, { events: [event({ logIndex: 7 })] })],
        "cursor-b",
      );
      const fromFirst = yield* store.readPoolEvents({
        environmentId: env,
        sourceId: first.sourceId,
        fromBlock: "600",
        toBlock: "600",
      });
      const fromSecond = yield* store.readPoolEvents({
        environmentId: env,
        sourceId: second.sourceId,
        fromBlock: "600",
        toBlock: "600",
      });
      assert.equal(fromFirst.length, 1);
      assert.equal(fromFirst[0]?.logIndex, 42);
      assert.equal(fromSecond.length, 1);
      assert.equal(fromSecond[0]?.logIndex, 7);
    }),
  );
});
