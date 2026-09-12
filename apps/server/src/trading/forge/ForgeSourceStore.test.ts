import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import createEvidenceTable from "../../persistence/Migrations/101_ForgeSourceEvidence.ts";
import { makeForgeSourceStore, type ForgeEvidenceInsert } from "./ForgeSourceStore.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());
const capture: ForgeEvidenceInsert = {
  record: {
    evidenceId: "ds-capture",
    environmentId: "env",
    poolId: `0x${"1".repeat(40)}`,
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
  observations: [],
  queryCapture: {
    query: "query Example { _meta { deployment } }",
    variables: [
      { pool: `0x${"1".repeat(40)}`, first: 100, cursor: "", block: 100, from: "1", to: "2" },
    ],
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
      assert.deepEqual(read?.observations, []);
      yield* store.insert({
        record: { ...capture.record, evidenceId: "legacy" },
        observations: [],
      });
      const legacy = yield* store.readObservations("legacy");
      assert.ok(legacy);
      assert.equal(legacy?.queryCapture, undefined);
    }),
  );
});
