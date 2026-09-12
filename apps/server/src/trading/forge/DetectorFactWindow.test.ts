/**
 * DetectorFactWindow — the sealed fact-set boundary over both source kinds:
 * resolution, bounded summary facts, SealedSourceRecord completeness fields,
 * and the absence discipline (retracted / integrity shortfall / environment
 * mismatch / over cap / all missing). Real stores over in-memory SQLite.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off - fixtures hash with node:crypto; JSON is the storage codec the stores under test use.

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ForgeSwapObservation } from "@t3tools/trading-contracts";

import createEvidenceTable from "../../persistence/Migrations/101_ForgeSourceEvidence.ts";
import createRevisionsTable from "../../persistence/Migrations/103_ExternalSourceRevisions.ts";
import {
  DetectorFactWindow,
  makeDetectorFactWindow,
  type DetectorFactWindowShape,
} from "./DetectorFactWindow.ts";
import {
  makeForgeSourceStore,
  ForgeSourceStore,
  type ForgeSourceStoreShape,
} from "./ForgeSourceStore.ts";
import {
  ExternalSourceStore,
  makeExternalSourceStore,
  type ExternalSourceRevision,
  type ExternalSourceStoreShape,
} from "../research/ExternalSourceStore.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";

const ENV = "env_fact_window";
const POOL: `0x${string}` = `0x${"1".repeat(40)}`;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const layer = it.layer(NodeSqliteClient.layerMemory());

// The memory layer is shared across cases, so each starts by (re)creating the
// tables and clearing its rows.
const reset = Effect.gen(function* () {
  yield* createEvidenceTable;
  yield* createRevisionsTable;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM forge_source_evidence`;
  yield* sql`DELETE FROM external_source_revisions`;
});

/** The window plus its two backing stores, built over the shared client. */
const makeWindow = Effect.gen(function* () {
  const graph = yield* makeForgeSourceStore;
  const external = yield* makeExternalSourceStore;
  const window = yield* makeDetectorFactWindow.pipe(
    Effect.provideService(ForgeSourceStore, ForgeSourceStore.of(graph)),
    Effect.provideService(ExternalSourceStore, ExternalSourceStore.of(external)),
  );
  return { graph, external, window };
});

const observation = (suffix: string, timestamp: number): ForgeSwapObservation => ({
  chain: "ethereum-mainnet",
  poolId: POOL,
  observationId: `0x${suffix.repeat(64)}:0`,
  transactionHash: `0x${suffix.repeat(64)}`,
  logIndex: 0,
  timestamp,
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

/** Seed one retained graph dataset; its digest is the honest content hash. */
const seedDataset = (
  graph: ForgeSourceStoreShape,
  input: {
    readonly evidenceId: string;
    readonly environmentId?: string;
    readonly observations: ReadonlyArray<ForgeSwapObservation>;
  },
) =>
  graph.insert({
    record: {
      evidenceId: input.evidenceId,
      environmentId: input.environmentId ?? ENV,
      poolId: POOL,
      historical: true,
      endpoint: "https://example.test",
      deployment: "dep-1",
      pinnedBlock: 1_000,
      pinnedBlockHash: "0x" + "cd".repeat(32),
      windowStart: 1_700_000_000,
      windowEnd: 1_700_000_100,
      fetchedAtMs: 1_700_000_200_000,
      digest: sha256(forgeJsonEncode(input.observations)),
      observationCount: input.observations.length,
    },
    observations: input.observations,
  });

const revision = (overrides?: Partial<ExternalSourceRevision>): ExternalSourceRevision => ({
  revisionId: "rev-1",
  environmentId: ENV,
  sourceKind: "github-releases",
  documentIdentity: "github-release:o/r:v1.0.0",
  sourceUrl: "https://github.com/o/r/releases/tag/v1.0.0",
  contentSha256: "a".repeat(64),
  publishedAtMs: 1_000,
  timePrecision: "instant",
  firstObservedAtMs: 2_000,
  captureMs: 2_000,
  correctionOf: null,
  retracted: false,
  ...overrides,
});

const seedDocument = (
  external: ExternalSourceStoreShape,
  rows: ReadonlyArray<ExternalSourceRevision>,
) =>
  Effect.all(
    rows.map((row) => external.insert({ revision: row, payloadJson: '{"id":1}' })),
    { concurrency: "unbounded" },
  );

const build = (
  window: DetectorFactWindowShape,
  requiredSourceIds: ReadonlyArray<string>,
  asOfMs = 1,
) => window.buildWindow({ environmentId: ENV, requiredSourceIds, asOfMs });

layer("graph-dataset sources", (it) => {
  it.effect(
    "resolves a retained dataset into a bounded fact set with a complete sealed record",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const { graph, window } = yield* makeWindow;
        const observations = [observation("1", 1_700_000_010), observation("2", 1_700_000_050)];
        const id = `ds_${"a".repeat(21)}`;
        yield* seedDataset(graph, { evidenceId: id, observations });

        const outcome = yield* build(window, [`graph-dataset:${id}`]);
        assert.equal(outcome.status, "ok");
        if (outcome.status !== "ok") return;
        assert.deepEqual(outcome.missingSourceIds, []);
        assert.equal(outcome.sources.length, 1);
        const source = outcome.sources[0]!;
        assert.equal(source.sourceId, `graph-dataset:${id}`);
        assert.equal(source.mode, "historical-replay");
        assert.equal(source.evidenceId, id);
        assert.equal(source.contentSha256, sha256(forgeJsonEncode(observations)));
        assert.isTrue(source.complete);
        assert.equal(source.availabilityBasis, "recorded");
        assert.equal(source.availableAtMs, 1_700_000_200_000);
        assert.equal(source.sourceRevision, "1000");
        // A dataset's events span its window: no single event instant claimed.
        assert.isUndefined(source.eventAtMs);

        const byKey = new Map(outcome.facts.map((fact) => [fact.key, fact]));
        assert.deepEqual(byKey.get("graph.pool.observation-count")?.value, {
          kind: "decimal",
          value: "2",
          unit: "observations",
        });
        // Last price from the LAST observation by (timestamp, logIndex).
        assert.deepEqual(byKey.get("graph.pool.last-price-micros")?.value, {
          kind: "decimal",
          value: "2000000000",
          unit: "micros",
        });
        assert.deepEqual(byKey.get("graph.pool.trade-window-start-ms")?.value, {
          kind: "decimal",
          value: "1700000000000",
          unit: "ms",
        });
        assert.deepEqual(byKey.get("graph.pool.trade-window-end-ms")?.value, {
          kind: "decimal",
          value: "1700000100000",
          unit: "ms",
        });
        // Bounded summary facts only — never one fact per observation.
        assert.equal(outcome.facts.length, 4);
        // Every fact cites the dataset evidence.
        for (const fact of outcome.facts) {
          assert.equal(fact.entityId, POOL);
          assert.equal(fact.evidence.length, 1);
          assert.equal(fact.evidence[0]?.id, id);
          assert.equal(fact.evidence[0]?.mode, "historical-replay");
        }
      }),
  );

  it.effect("an integrity shortfall (claimed count or digest) is absence", () =>
    Effect.gen(function* () {
      yield* reset;
      const { graph, window } = yield* makeWindow;
      const sql = yield* SqlClient.SqlClient;
      const id = `ds_${"b".repeat(21)}`;
      yield* seedDataset(graph, {
        evidenceId: id,
        observations: [observation("3", 1_700_000_010)],
      });
      // Claim three rows, retain one.
      yield* sql`UPDATE forge_source_evidence SET observation_count = 3 WHERE evidence_id = ${id}`;
      const claimed = yield* build(window, [`graph-dataset:${id}`]);
      assert.equal(claimed.status, "unavailable");
      if (claimed.status === "unavailable") assert.include(claimed.reason, id);

      // Digest tampering: the row's digest no longer matches its bytes.
      yield* sql`UPDATE forge_source_evidence SET observation_count = 1, digest = ${"f".repeat(64)} WHERE evidence_id = ${id}`;
      const tampered = yield* build(window, [`graph-dataset:${id}`]);
      assert.equal(tampered.status, "unavailable");
    }),
  );

  it.effect("another environment's dataset is absence", () =>
    Effect.gen(function* () {
      yield* reset;
      const { graph, window } = yield* makeWindow;
      const id = `ds_${"c".repeat(21)}`;
      yield* seedDataset(graph, {
        evidenceId: id,
        environmentId: "env_other",
        observations: [observation("4", 1_700_000_010)],
      });
      const outcome = yield* build(window, [`graph-dataset:${id}`]);
      assert.equal(outcome.status, "unavailable");
      if (outcome.status === "unavailable") assert.include(outcome.reason, id);
    }),
  );
});

layer("external sources", (it) => {
  it.effect(
    "resolves the revision chain head into publication facts with a live sealed record",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const { external, window } = yield* makeWindow;
        yield* seedDocument(external, [
          revision({ revisionId: "rev-1", publishedAtMs: 1_000, firstObservedAtMs: 2_000 }),
          revision({
            revisionId: "rev-2",
            correctionOf: "rev-1",
            contentSha256: "b".repeat(64),
            publishedAtMs: 1_200,
            firstObservedAtMs: 3_000,
          }),
        ]);

        const outcome = yield* build(window, [
          "external:github-releases:github-release:o/r:v1.0.0",
        ]);
        assert.equal(outcome.status, "ok");
        if (outcome.status !== "ok") return;
        assert.equal(outcome.sources.length, 1);
        const source = outcome.sources[0]!;
        // The correction chain HEAD is the source: rev-2, not rev-1.
        assert.equal(source.evidenceId, "rev-2");
        assert.equal(source.mode, "live");
        assert.equal(source.contentSha256, "b".repeat(64));
        assert.isTrue(source.complete);
        assert.equal(source.eventAtMs, 1_200);
        assert.equal(source.availableAtMs, 3_000);
        assert.equal(source.availabilityBasis, "recorded");
        assert.equal(source.sourceRevision, "rev-2");

        const byKey = new Map(outcome.facts.map((fact) => [fact.key, fact]));
        assert.deepEqual(byKey.get("external.document.published")?.value, {
          kind: "boolean",
          value: true,
        });
        assert.deepEqual(byKey.get("external.document.publication-ms")?.value, {
          kind: "decimal",
          value: "1200",
          unit: "ms",
        });
        // Free text never crosses: exactly the two bounded facts.
        assert.equal(outcome.facts.length, 2);
      }),
  );

  it.effect("a retracted latest is absence, named in the refusal", () =>
    Effect.gen(function* () {
      yield* reset;
      const { external, window } = yield* makeWindow;
      const id = "external:github-releases:github-release:o/r:v1.0.0";
      yield* seedDocument(external, [
        revision({ revisionId: "rev-1" }),
        revision({
          revisionId: "rev-2",
          correctionOf: "rev-1",
          retracted: true,
          firstObservedAtMs: 3_000,
        }),
      ]);
      // Sole required source missing is a total refusal that names it.
      const outcome = yield* build(window, [id]);
      assert.equal(outcome.status, "unavailable");
      if (outcome.status === "unavailable") assert.include(outcome.reason, id);
    }),
  );

  it.effect("an undated document is complete with its event time omitted", () =>
    Effect.gen(function* () {
      yield* reset;
      const { external, window } = yield* makeWindow;
      yield* seedDocument(external, [
        revision({
          revisionId: "rev-date",
          publishedAtMs: null,
          timePrecision: "date",
          firstObservedAtMs: 9_000,
        }),
      ]);
      const outcome = yield* build(window, ["external:github-releases:github-release:o/r:v1.0.0"]);
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      const source = outcome.sources[0]!;
      assert.isTrue(source.complete);
      assert.isUndefined(source.eventAtMs);
      assert.equal(source.availableAtMs, 9_000);
      // No publication instant exists to state.
      const keys = outcome.facts.map((fact) => fact.key);
      assert.include(keys, "external.document.published");
      assert.notInclude(keys, "external.document.publication-ms");
    }),
  );
});

layer("window discipline", (it) => {
  it.effect("a partial window keeps the ok shape with the missing source named", () =>
    Effect.gen(function* () {
      yield* reset;
      const { graph, window } = yield* makeWindow;
      const retained = `graph-dataset:ds_${"d".repeat(21)}`;
      yield* seedDataset(graph, {
        evidenceId: `ds_${"d".repeat(21)}`,
        observations: [observation("5", 1_700_000_010)],
      });
      const absent = "external:github-releases:never-captured";
      const outcome = yield* build(window, [retained, absent]);
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      // The ok result NEVER includes missing sources in `sources`; the name
      // rides in missingSourceIds as information for logs and jobs.
      assert.deepEqual(outcome.missingSourceIds, [absent]);
      assert.equal(outcome.sources.length, 1);
      assert.equal(outcome.sources[0]?.sourceId, retained);
    }),
  );

  it.effect("over the source cap refuses up front, naming the cap", () =>
    Effect.gen(function* () {
      yield* reset;
      const { window } = yield* makeWindow;
      const ids = Array.from({ length: 17 }, (_, index) => `graph-dataset:ds_${index}`);
      const outcome = yield* build(window, ids);
      assert.equal(outcome.status, "unavailable");
      if (outcome.status === "unavailable") assert.include(outcome.reason, "16-source");
    }),
  );

  it.effect("all sources missing is a total refusal naming every id", () =>
    Effect.gen(function* () {
      yield* reset;
      const { window } = yield* makeWindow;
      const outcome = yield* build(window, ["graph-dataset:ds_none", "external:feed:nope"]);
      assert.equal(outcome.status, "unavailable");
      if (outcome.status === "unavailable") {
        assert.include(outcome.reason, "graph-dataset:ds_none");
        assert.include(outcome.reason, "external:feed:nope");
      }
    }),
  );

  it.effect("a malformed source id is absence, never a throw", () =>
    Effect.gen(function* () {
      yield* reset;
      const { window } = yield* makeWindow;
      const outcome = yield* build(window, ["external:sourcekindwithoutidentity"]);
      assert.equal(outcome.status, "unavailable");
    }),
  );
});
