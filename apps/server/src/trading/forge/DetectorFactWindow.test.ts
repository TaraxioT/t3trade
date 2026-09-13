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
import { eligibleAt, type ForgeSwapObservation } from "@t3tools/trading-contracts";

import createEvidenceTable from "../../persistence/Migrations/101_ForgeSourceEvidence.ts";
import createRevisionsTable from "../../persistence/Migrations/103_ExternalSourceRevisions.ts";
import {
  DetectorFactWindow,
  makeDetectorFactWindow,
  SubstreamsSourceReader,
  type DetectorFactWindowShape,
  type SubstreamsPoolEvent,
  type SubstreamsSourceReaderShape,
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
import { compileScenarioPrograms, launchPolicySource } from "./scenarioPacks/scenarioFixtures.ts";
import { flowRevisionDetectorSource } from "./scenarioPacks/flowRevisionPrograms.ts";

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

/** The window with a Substreams reader bound (the integration shape). */
const makeWindowWithStreams = (reader: SubstreamsSourceReaderShape) =>
  makeWindow.pipe(Effect.provideService(SubstreamsSourceReader, SubstreamsSourceReader.of(reader)));

// ---------------------------------------------------------------------------
// DEVELOPMENT FAKE — Worker A's SubstreamsSourceStore stand-in. It implements
// EXACTLY the frozen A→B reader port (parallel-checkpoint.md); Worker A's real
// store replaces it at integration and this fake is never shipped.
// ---------------------------------------------------------------------------

const POOL_STREAM = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";

interface FakeBlock {
  readonly number: string;
  readonly hash: string;
  readonly timestampMs: number;
  readonly eventCount: number;
}

const fakeSubstreamsStore = (input: {
  readonly blocks: ReadonlyArray<FakeBlock>;
  readonly events?: ReadonlyArray<SubstreamsPoolEvent>;
  /** Overrides the derived watermark (simulate a lagging final watermark). */
  readonly watermarkBlock?: string | undefined;
  readonly healthState?: "healthy" | "stale" | "unhealthy" | undefined;
  readonly revision?: string | null;
  readonly lastCommitAtMs?: number | undefined;
}) => {
  const state = { healthState: input.healthState ?? "healthy" };
  const byNumber = [...input.blocks].sort((a, b) => Number(BigInt(a.number) - BigInt(b.number)));
  const watermark = (): {
    finalWatermarkBlock: string;
    finalWatermarkTimestampMs: number;
  } | null => {
    const target =
      input.watermarkBlock !== undefined
        ? byNumber.find((block) => block.number === input.watermarkBlock)
        : byNumber[byNumber.length - 1];
    return target === undefined
      ? null
      : { finalWatermarkBlock: target.number, finalWatermarkTimestampMs: target.timestampMs };
  };
  const reader: SubstreamsSourceReaderShape = {
    committedWatermark: (_environmentId, _sourceId) => watermark(),
    readBlockEnvelopes: (_environmentId, _sourceId, fromBlock, toBlock) => {
      const from = BigInt(fromBlock);
      const to = BigInt(toBlock);
      return {
        blocks: byNumber.filter((block) => {
          const number = BigInt(block.number);
          return number >= from && number <= to;
        }),
      };
    },
    readPoolEvents: (_environmentId, _sourceId, fromBlock, toBlock) => {
      const from = BigInt(fromBlock);
      const to = BigInt(toBlock);
      return (input.events ?? []).filter((event) => {
        const number = BigInt(event.blockNumber);
        return number >= from && number <= to;
      });
    },
    sourceHealth: (_environmentId, _sourceId) => {
      const head = watermark();
      return {
        state: state.healthState,
        reason: state.healthState === "healthy" ? "" : "fixture state",
        finalWatermarkBlock: head?.finalWatermarkBlock ?? "0",
        finalWatermarkTimestampMs: head?.finalWatermarkTimestampMs ?? 0,
        lastCommitAtMs: input.lastCommitAtMs ?? (head?.finalWatermarkTimestampMs ?? 0) + 45_000,
        cursor: "fixture-cursor",
        packageSha256: "a".repeat(64),
        moduleDigest: "b".repeat(64),
      };
    },
    sourceRevision: (_environmentId, _sourceId) =>
      input.revision === undefined ? "pkg-module-params-1" : input.revision,
  };
  return { reader, state };
};

/** 12 s cadence blocks covering [fromMs, toMs) (exclusive end), numbered from `first`. */
const cadenceBlocks = (fromMs: number, toMs: number, first: number): Array<FakeBlock> => {
  const blocks: Array<FakeBlock> = [];
  let number = first;
  for (let ts = fromMs; ts < toMs; ts += 12_000) {
    blocks.push({
      number: String(number),
      hash: `0x${String(number).padStart(4, "0").repeat(16).slice(0, 64)}`,
      timestampMs: ts,
      eventCount: 0,
    });
    number += 1;
  }
  return blocks;
};

const event = (
  blockNumber: string,
  logIndex: number,
  amount0: string,
  amount1: string,
): SubstreamsPoolEvent => ({
  blockNumber,
  blockHash: `0x${String(blockNumber).padStart(4, "0").repeat(16).slice(0, 64)}`,
  transactionHash: `0x${String(logIndex).padStart(4, "0").repeat(16).slice(0, 64)}`,
  logIndex,
  pool: POOL_STREAM,
  amount0Raw: amount0,
  amount1Raw: amount1,
  sqrtPriceX96: "7918652471" + String(logIndex),
  sender: "0x1",
  recipient: "0x2",
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
        assert.equal(outcome.facts.length, 6);
        // Every fact cites the dataset evidence.
        for (const fact of outcome.facts) {
          assert.equal(fact.entityId, POOL);
          assert.equal(fact.evidence.length, 1);
          assert.equal(fact.evidence[0]?.id, id);
          assert.equal(fact.evidence[0]?.mode, "historical-replay");
        }
      }),
  );

  it.effect("net and gross retain exact raw units and distinguish offsetting flow", () =>
    Effect.gen(function* () {
      yield* reset;
      const { graph, window } = yield* makeWindow;
      const buy = "900719925474099312345";
      const sell = "900719925474099312344";
      yield* seedDataset(graph, {
        evidenceId: "ds_flow",
        observations: [
          { ...observation("1", 1_700_000_010), amount0: buy, quoteVolumeRaw: buy },
          {
            ...observation("2", 1_700_000_050),
            amount0: `-${sell}`,
            amount1: "500",
            quoteVolumeRaw: sell,
          },
        ],
      });
      const result = yield* build(window, ["graph-dataset:ds_flow"]);
      assert.equal(result.status, "ok");
      if (result.status !== "ok") return;
      const values = new Map(result.facts.map((fact) => [fact.key, fact.value]));
      assert.deepEqual(values.get("graph.pool.net-flow-quote-raw"), {
        kind: "decimal",
        value: "1",
        unit: "quote-token-raw",
      });
      assert.deepEqual(values.get("graph.pool.gross-flow-quote-raw"), {
        kind: "decimal",
        value: "1801439850948198624689",
        unit: "quote-token-raw",
      });
      // Compile two actual artifact revisions, then replay the IDENTICAL sealed
      // input. There is no metric/scenario switch in the host evaluator.
      const input = {
        programSchemaVersion: 2,
        asOfMs: 1_700_000_300_000,
        inputDigest: sha256(forgeJsonEncode(result)),
        facts: result.facts,
        sources: result.sources,
        priorState: null,
      };
      const before = forgeJsonEncode(input);
      const gross = flowRevisionDetectorSource("graph-dataset:ds_flow", "gross", "100");
      const net = flowRevisionDetectorSource("graph-dataset:ds_flow", "net", "100");
      assert.notEqual(sha256(gross), sha256(net));
      for (const [detectorSource, expected] of [
        [gross, "matched"],
        [net, "not-matched"],
      ] as const) {
        yield* Effect.promise(async () => {
          const program = await compileScenarioPrograms({
            detectorSource,
            testSource: "",
            policySource: launchPolicySource,
          });
          try {
            const output = program.detect(input);
            assert.equal((output.result as { status: string }).status, expected);
            assert.deepEqual(program.detect(input), output);
            assert.equal(forgeJsonEncode(input), before);
          } finally {
            await program.cleanup();
          }
        });
      }
    }),
  );

  it.effect("raw flow signs follow base orientation and empty datasets remain zero", () =>
    Effect.gen(function* () {
      yield* reset;
      const { graph, window } = yield* makeWindow;
      const cases = [
        {
          id: "ds_sell",
          rows: [{ ...observation("1", 1_700_000_010), amount0: "-1000000", amount1: "500" }],
          net: "-1000000",
          gross: "1000000",
        },
        {
          id: "ds_other_base",
          rows: [
            {
              ...observation("1", 1_700_000_010),
              baseIsToken1: false,
              amount0: "-500",
              amount1: "1000000",
            },
          ],
          net: "1000000",
          gross: "1000000",
        },
        { id: "ds_empty", rows: [], net: "0", gross: "0" },
      ];
      for (const row of cases) {
        yield* seedDataset(graph, { evidenceId: row.id, observations: row.rows });
        const outcome = yield* build(window, [`graph-dataset:${row.id}`]);
        assert.equal(outcome.status, "ok");
        if (outcome.status !== "ok") continue;
        for (const [key, expected] of [
          ["net", row.net],
          ["gross", row.gross],
        ] as const) {
          assert.deepEqual(
            outcome.facts.find((fact) => fact.key === `graph.pool.${key}-flow-quote-raw`)?.value,
            { kind: "decimal", value: expected, unit: "quote-token-raw" },
          );
        }
      }
    }),
  );

  it.effect("inconsistent quote units or mixed pool orientation are absent", () =>
    Effect.gen(function* () {
      yield* reset;
      const { graph, window } = yield* makeWindow;
      const invalidRows: ReadonlyArray<ReadonlyArray<ForgeSwapObservation>> = [
        [{ ...observation("1", 1_700_000_010), quoteVolumeRaw: "2" }],
        [
          observation("1", 1_700_000_010),
          { ...observation("2", 1_700_000_020), baseIsToken1: false },
        ],
        [{ ...observation("1", 1_700_000_010), poolId: `0x${"2".repeat(40)}` }],
        [observation("1", 1_700_000_101)],
      ];
      for (const [index, observations] of invalidRows.entries()) {
        const id = `ds_invalid_${index}`;
        yield* seedDataset(graph, { evidenceId: id, observations });
        assert.equal((yield* build(window, [`graph-dataset:${id}`])).status, "unavailable");
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

// ---------------------------------------------------------------------------
// substreams: sources (the frozen A→B port, against the development fake)
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
/** An hour-aligned base instant, so grid arithmetic is exact in the fixtures. */
const ALIGNED_BASE = 472_223 * HOUR_MS;

layer("substreams sources", (it) => {
  it.effect("a complete window resolves into exact live facts with finite expiry", () =>
    Effect.gen(function* () {
      yield* reset;
      const start = ALIGNED_BASE - HOUR_MS;
      const end = ALIGNED_BASE;
      const first = 18_000_000;
      const blocks = cadenceBlocks(start - 24_000, end + 60_000, first);
      const endBlockNumber = first + 301;
      const lastCommitAtMs = end + 45_000;
      const { reader } = fakeSubstreamsStore({
        blocks,
        events: [
          event(String(first + 10), 3, "1000000", "-500000000000000000"),
          event(String(first + 200), 1, "-2500000", "1250000000000000000"),
          // Out of the window's block range entirely: must never be summed.
          event(String(first + 1), 7, "999999999", "-999999999"),
        ],
        lastCommitAtMs,
      });
      const { window } = yield* makeWindowWithStreams(reader);
      const asOfMs = end + 30 * 60_000;
      const outcome = yield* build(window, ["substreams:pool-obs-main:3600000"], asOfMs);
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      assert.deepEqual(outcome.missingSourceIds, []);
      assert.equal(outcome.sources.length, 1);
      const source = outcome.sources[0]!;
      assert.equal(source.sourceId, "substreams:pool-obs-main:3600000");
      assert.equal(source.mode, "live");
      assert.isTrue(source.complete);
      assert.equal(source.availabilityBasis, "recorded");
      // The grid rule: end is the last hour boundary at or before the clock.
      assert.equal(source.eventAtMs, end);
      assert.equal(source.availableAtMs, lastCommitAtMs);
      // FINITE expiry: window close + the validity horizon, never NO_EXPIRY_MS.
      assert.equal(source.expiresAtMs, end + 24 * 60 * 60 * 1000);
      assert.equal(source.sourceRevision, "pkg-module-params-1");
      assert.isTrue(source.evidenceId.startsWith("sev_"));

      const byKey = new Map(outcome.facts.map((fact) => [fact.key, fact.value]));
      assert.deepEqual(byKey.get("stream.window.event-count"), {
        kind: "decimal",
        value: "2",
        unit: "events",
      });
      // Exact signed sums; the pre-window event never crosses.
      assert.deepEqual(byKey.get("stream.window.net-amount0-raw"), {
        kind: "decimal",
        value: "-1500000",
        unit: "token0-raw",
      });
      assert.deepEqual(byKey.get("stream.window.net-amount1-raw"), {
        kind: "decimal",
        value: "750000000000000000",
        unit: "token1-raw",
      });
      assert.deepEqual(byKey.get("stream.window.gross-amount0-raw"), {
        kind: "decimal",
        value: "3500000",
        unit: "token0-raw",
      });
      assert.deepEqual(byKey.get("stream.window.gross-amount1-raw"), {
        kind: "decimal",
        value: "1750000000000000000",
        unit: "token1-raw",
      });
      // Last price by (block, logIndex) order, not array order.
      assert.deepEqual(byKey.get("stream.window.last-sqrt-price-x96"), {
        kind: "decimal",
        value: "79186524711",
        unit: "raw",
      });
      assert.deepEqual(byKey.get("stream.window.start-ms"), {
        kind: "decimal",
        value: String(start),
        unit: "ms",
      });
      assert.deepEqual(byKey.get("stream.window.end-ms"), {
        kind: "decimal",
        value: String(end),
        unit: "ms",
      });
      assert.deepEqual(byKey.get("stream.window.end-block"), {
        kind: "decimal",
        value: String(endBlockNumber),
        unit: "block",
      });
      assert.equal(outcome.facts.length, 9);

      // The evidence time fields satisfy eligibleAt at a plausible decision
      // instant, and expire one validity horizon after the window closed.
      const evidence = outcome.facts[0]!.evidence[0]!;
      assert.equal(evidence.mode, "live");
      assert.isTrue(
        eligibleAt(
          {
            eventAtMs: evidence.eventAtMs,
            availableAtMs: evidence.availableAtMs,
            availabilityBasis: evidence.availabilityBasis,
            expiresAtMs: evidence.expiresAtMs,
            final: true,
          },
          asOfMs + 1_000,
        ),
      );
      assert.isFalse(
        eligibleAt(
          {
            eventAtMs: evidence.eventAtMs,
            availableAtMs: evidence.availableAtMs,
            availabilityBasis: evidence.availabilityBasis,
            expiresAtMs: evidence.expiresAtMs,
            final: true,
          },
          end + 24 * 60 * 60 * 1000 + 1,
        ),
      );
      // Every fact cites the sealed window evidence.
      for (const fact of outcome.facts) {
        assert.equal(fact.entityId, "pool-obs-main");
        assert.equal(fact.evidence.length, 1);
        assert.equal(fact.evidence[0]?.id, source.evidenceId);
      }
    }),
  );

  it.effect("an empty complete window is provable: zero events, no invented price", () =>
    Effect.gen(function* () {
      yield* reset;
      const start = ALIGNED_BASE - HOUR_MS;
      const end = ALIGNED_BASE;
      const blocks = cadenceBlocks(start - 24_000, end + 60_000, 18_000_000);
      const { reader } = fakeSubstreamsStore({ blocks, events: [] });
      const { window } = yield* makeWindowWithStreams(reader);
      const outcome = yield* build(window, ["substreams:pool-obs-main:3600000"], end + 30 * 60_000);
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      assert.isTrue(outcome.sources[0]?.complete);
      const byKey = new Map(outcome.facts.map((fact) => [fact.key, fact.value]));
      assert.deepEqual(byKey.get("stream.window.event-count"), {
        kind: "decimal",
        value: "0",
        unit: "events",
      });
      assert.isUndefined(byKey.get("stream.window.last-sqrt-price-x96"));
      assert.deepEqual(byKey.get("stream.window.net-amount0-raw"), {
        kind: "decimal",
        value: "0",
        unit: "token0-raw",
      });
    }),
  );

  it.effect("a watermark short of the window end is an incomplete sealed record, not absence", () =>
    Effect.gen(function* () {
      yield* reset;
      const start = ALIGNED_BASE - HOUR_MS;
      const end = ALIGNED_BASE;
      const blocks = cadenceBlocks(start - 24_000, end + 60_000, 18_000_000);
      const { reader } = fakeSubstreamsStore({
        blocks,
        // Watermark stuck 150 blocks into the window: end is not provable.
        watermarkBlock: String(18_000_000 + 150),
      });
      const { window } = yield* makeWindowWithStreams(reader);
      const outcome = yield* build(window, ["substreams:pool-obs-main:3600000"], end + 30 * 60_000);
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      assert.deepEqual(outcome.missingSourceIds, []);
      const source = outcome.sources[0]!;
      assert.isFalse(source.complete);
      assert.equal(source.mode, "live");
      assert.equal(source.availabilityBasis, "unknown");
      assert.isUndefined(source.availableAtMs);
      assert.isUndefined(source.expiresAtMs);
      // No facts from an unprovable window.
      assert.isEmpty(outcome.facts);
    }),
  );

  it.effect("an envelope gap inside the window's block range is incomplete", () =>
    Effect.gen(function* () {
      yield* reset;
      const start = ALIGNED_BASE - HOUR_MS;
      const end = ALIGNED_BASE;
      const blocks = cadenceBlocks(start - 24_000, end + 60_000, 18_000_000).filter(
        (block) => block.number !== String(18_000_000 + 100),
      );
      const { reader } = fakeSubstreamsStore({ blocks });
      const { window } = yield* makeWindowWithStreams(reader);
      const outcome = yield* build(window, ["substreams:pool-obs-main:3600000"], end + 30 * 60_000);
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      assert.isFalse(outcome.sources[0]?.complete);
      assert.isEmpty(outcome.facts);
    }),
  );

  it.effect("a stale or unhealthy source is an incomplete sealed record", () =>
    Effect.gen(function* () {
      yield* reset;
      const start = ALIGNED_BASE - HOUR_MS;
      const end = ALIGNED_BASE;
      const blocks = cadenceBlocks(start - 24_000, end + 60_000, 18_000_000);
      for (const state of ["stale", "unhealthy"] as const) {
        const { reader } = fakeSubstreamsStore({ blocks, healthState: state });
        const { window } = yield* makeWindowWithStreams(reader);
        const outcome = yield* build(
          window,
          ["substreams:pool-obs-main:3600000"],
          end + 30 * 60_000,
        );
        assert.equal(outcome.status, "ok");
        if (outcome.status !== "ok") return;
        assert.isFalse(outcome.sources[0]?.complete);
        assert.isEmpty(outcome.facts);
      }
    }),
  );

  it.effect("an envelope read that cannot reach before the window start is incomplete", () =>
    Effect.gen(function* () {
      yield* reset;
      const start = ALIGNED_BASE - HOUR_MS;
      const end = ALIGNED_BASE;
      // Blocks exist only from a minute inside the window onward: the bounded
      // lookback cannot prove the window's start is covered.
      const blocks = cadenceBlocks(start + 60_000, end + 60_000, 18_000_000);
      const { reader } = fakeSubstreamsStore({ blocks });
      const { window } = yield* makeWindowWithStreams(reader);
      const outcome = yield* build(window, ["substreams:pool-obs-main:3600000"], end + 30 * 60_000);
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      assert.isFalse(outcome.sources[0]?.complete);
    }),
  );

  it.effect("events from a second pool refuse the window rather than mixing sums", () =>
    Effect.gen(function* () {
      yield* reset;
      const start = ALIGNED_BASE - HOUR_MS;
      const end = ALIGNED_BASE;
      const blocks = cadenceBlocks(start - 24_000, end + 60_000, 18_000_000);
      const { reader } = fakeSubstreamsStore({
        blocks,
        events: [
          event(String(18_000_000 + 10), 0, "1", "-1"),
          {
            ...event(String(18_000_000 + 11), 0, "2", "-2"),
            pool: POOL_STREAM.slice(0, -1) + "7",
          },
        ],
      });
      const { window } = yield* makeWindowWithStreams(reader);
      const outcome = yield* build(window, ["substreams:pool-obs-main:3600000"], end + 30 * 60_000);
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      assert.isFalse(outcome.sources[0]?.complete);
      assert.isEmpty(outcome.facts);
    }),
  );

  it.effect("an unknown source, an unwired reader, and malformed ids are absence", () =>
    Effect.gen(function* () {
      yield* reset;
      const start = ALIGNED_BASE - HOUR_MS;
      const end = ALIGNED_BASE;
      const blocks = cadenceBlocks(start - 24_000, end + 60_000, 18_000_000);

      // Known-shape store that does not know this source: absence. As the
      // SOLE required source, absence is the existing total refusal that names it.
      const unknown = fakeSubstreamsStore({ blocks, revision: null });
      const { window: unknownWindow } = yield* makeWindowWithStreams(unknown.reader);
      const unknownOutcome = yield* build(unknownWindow, ["substreams:pool-obs-main:3600000"], end);
      assert.equal(unknownOutcome.status, "unavailable");
      if (unknownOutcome.status === "unavailable") {
        assert.include(unknownOutcome.reason, "substreams:pool-obs-main:3600000");
      }

      // No reader wired at all: absence, never a crash.
      const { window: bare } = yield* makeWindow;
      const bareOutcome = yield* build(bare, ["substreams:pool-obs-main:3600000"], end);
      assert.equal(bareOutcome.status, "unavailable");

      // Malformed selectors: no window selector, below-min, above-cap, and a
      // non-decimal one — every one is absence named in the total refusal.
      const { reader } = fakeSubstreamsStore({ blocks });
      const { window } = yield* makeWindowWithStreams(reader);
      for (const id of [
        "substreams:pool-obs-main",
        "substreams:pool-obs-main:59999",
        "substreams:pool-obs-main:90000000",
        "substreams::3600000",
        "substreams:pool-obs-main:36abc",
      ]) {
        const outcome = yield* build(window, [id], end + 30 * 60_000);
        assert.equal(outcome.status, "unavailable", id);
        if (outcome.status === "unavailable") assert.include(outcome.reason, id, id);
      }
    }),
  );

  it.effect("a substreams source participates in a mixed window beside a retained dataset", () =>
    Effect.gen(function* () {
      yield* reset;
      const start = ALIGNED_BASE - HOUR_MS;
      const end = ALIGNED_BASE;
      const blocks = cadenceBlocks(start - 24_000, end + 60_000, 18_000_000);
      const { reader } = fakeSubstreamsStore({ blocks });
      const { graph, window } = yield* makeWindowWithStreams(reader);
      const datasetId = `ds_${"e".repeat(21)}`;
      yield* seedDataset(graph, {
        evidenceId: datasetId,
        observations: [observation("7", 1_700_000_010)],
      });
      const outcome = yield* build(
        window,
        [`graph-dataset:${datasetId}`, "substreams:pool-obs-main:3600000"],
        end + 30 * 60_000,
      );
      assert.equal(outcome.status, "ok");
      if (outcome.status !== "ok") return;
      assert.deepEqual(outcome.missingSourceIds, []);
      assert.equal(outcome.sources.length, 2);
      assert.isTrue(outcome.sources.every((source) => source.complete));
    }),
  );
});
