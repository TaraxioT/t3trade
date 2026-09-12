import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ForgeSwapObservation } from "@t3tools/trading-contracts";
import createEvidenceTable from "../../persistence/Migrations/101_ForgeSourceEvidence.ts";
import { makeForgeSourceStore, type ForgeEvidenceInsert } from "./ForgeSourceStore.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());
const POOL: `0x${string}` = `0x${"1".repeat(40)}`;
const observation = (suffix: string): ForgeSwapObservation => ({
  chain: "ethereum-mainnet",
  poolId: POOL,
  observationId: `0x${suffix.repeat(32)}:0`,
  transactionHash: `0x${suffix.repeat(32)}`,
  logIndex: 0,
  timestamp: 1,
  sender: "0xa",
  recipient: "0xb",
  amount0: "1000000",
  amount1: "-500",
  sqrtPriceX96: "1",
  tick: 0,
  baseIsToken1: true,
  priceQuotePerBase: { numerator: "2000", denominator: "1" },
  priceQuotePerBaseMicros: 2_000_000_000,
  quoteVolumeRaw: "1000000",
  quoteVolumeMicros: 1_000_000,
});
const capture: ForgeEvidenceInsert = {
  record: {
    evidenceId: "ds-capture",
    environmentId: "env",
    poolId: POOL,
    historical: true,
    endpoint: "https://graph.example",
    deployment: "deployment",
    pinnedBlock: 100,
    pinnedBlockHash: "hash",
    windowStart: 1,
    windowEnd: 2,
    fetchedAtMs: 3000,
    digest: "digest",
    observationCount: 0,
  },
  observations: [observation("aa")],
  queryCapture: {
    query: "query Example { _meta { deployment } }",
    variables: [{ pool: POOL, first: 100, cursor: "", block: 100, from: "1", to: "2" }],
  },
};

layer("ForgeSourceStore query capture", (it) => {
  it.effect("retains exact query bytes and variables while old payloads remain readable", () =>
    Effect.gen(function* () {
      yield* createEvidenceTable;
      const store = yield* makeForgeSourceStore;
      yield* store.insert(capture);
      const read = yield* store.readObservations(capture.record.evidenceId);
      assert.deepEqual(read?.queryCapture, capture.queryCapture);
      assert.deepEqual(read?.observations, capture.observations);
      assert.equal(read?.payloadIntact, true);
      yield* store.insert({
        record: { ...capture.record, evidenceId: "legacy" },
        observations: [],
      });
      const legacy = yield* store.readObservations("legacy");
      assert.ok(legacy);
      assert.equal(legacy?.queryCapture, undefined);
      assert.equal(legacy?.payloadIntact, true);
    }),
  );
});

layer("ForgeSourceStore insert immutability", (it) => {
  it.effect("persists the first insert and treats an identical re-insert as a no-op", () =>
    Effect.gen(function* () {
      yield* createEvidenceTable;
      const store = yield* makeForgeSourceStore;
      yield* store.insert(capture);
      yield* store.insert(capture);
      const read = yield* store.readObservations(capture.record.evidenceId);
      assert.deepEqual(read?.observations, capture.observations);
      assert.equal(read?.claimedCount, 1);
      assert.equal(read?.payloadIntact, true);
    }),
  );

  it.effect("refuses different content under an existing id and keeps the original payload", () =>
    Effect.gen(function* () {
      yield* createEvidenceTable;
      const store = yield* makeForgeSourceStore;
      yield* store.insert(capture);
      const error = yield* store
        .insert({ ...capture, observations: [observation("bb")] })
        .pipe(Effect.flip);
      assert.match(error.message, /evidence id collision: payload differs under an existing id/);
      const read = yield* store.readObservations(capture.record.evidenceId);
      // The refused insert must not have replaced or widened the row.
      assert.deepEqual(read?.observations, capture.observations);
      assert.equal(read?.claimedCount, 1);
    }),
  );
});

layer("ForgeSourceStore payload integrity flag", (it) => {
  it.effect(
    "reports payloadIntact false when the row claims more rows than the payload decodes",
    () =>
      Effect.gen(function* () {
        yield* createEvidenceTable;
        const store = yield* makeForgeSourceStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.insert(capture);
        yield* sql`
        UPDATE forge_source_evidence SET observation_count = 5
        WHERE evidence_id = ${capture.record.evidenceId}
      `;
        const read = yield* store.readObservations(capture.record.evidenceId);
        assert.equal(read?.claimedCount, 5);
        assert.equal(read?.observations.length, 1);
        assert.equal(read?.payloadIntact, false);
      }),
  );
});
