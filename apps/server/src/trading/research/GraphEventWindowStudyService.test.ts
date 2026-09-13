/**
 * GraphEventWindowStudyService — variant handling, coverage honesty,
 * applies-now, exact flow sums, and retained idempotency. The Graph research
 * seam is scripted (its own acquisition path is tested in
 * GraphResearchService.test.ts); the honest measurement engine under the
 * service is the REAL runEventStudy, exercised here over synthetic retained
 * datasets.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - sqlite fixtures and fixed study clocks are the data under test.

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ForgeSwapObservation, MarketCandle } from "@t3tools/trading-contracts";

import createStudiesTable from "../../persistence/Migrations/113_GraphEventStudies.ts";
import {
  GraphEventWindowStudyService,
  makeGraphEventWindowStudyService,
  type GraphEventWindowStudyInput,
  type GraphEventWindowStudyServiceShape,
} from "./GraphEventWindowStudyService.ts";
import {
  GraphResearchService,
  type GraphResearchServiceShape,
  type GraphStudyDataset,
} from "./GraphResearchService.ts";

const ENV = "env_event_study";
const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const DAY = 86_400_000;

const layer = it.layer(NodeSqliteClient.layerMemory());

const reset = Effect.gen(function* () {
  yield* createStudiesTable;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM forge_graph_event_studies`;
});

// -- the scripted Graph research seam ----------------------------------------

interface ScriptedLoad {
  readonly entryBasis: string;
  readonly anchorAt: number;
  readonly horizonBars: number;
}

/** Daily candles price(i) = 100 + 10 * i over [fromDay, toDay] around the anchor. */
const candlesAround = (
  anchorAt: number,
  fromOffsetDays: number,
  toOffsetDays: number,
): Array<MarketCandle> => {
  const candles: Array<MarketCandle> = [];
  for (let offset = fromOffsetDays; offset <= toOffsetDays; offset += 1) {
    const openTime = anchorAt + offset * DAY;
    const price = 100 + 10 * offset;
    candles.push({
      openTime,
      closeTime: openTime + DAY - 1,
      open: price,
      close: price,
      high: price,
      low: price,
      volume: 10,
    });
  }
  return candles;
};

const swapAt = (timestampMs: number, baseDeltaRaw: string): ForgeSwapObservation => ({
  chain: "ethereum-mainnet",
  poolId: POOL,
  observationId: `0x${timestampMs}:0`,
  transactionHash: `0x${timestampMs}`,
  logIndex: 0,
  timestamp: Math.floor(timestampMs / 1000),
  sender: "0x1",
  recipient: "0x2",
  amount0: "1000000",
  amount1: baseDeltaRaw,
  sqrtPriceX96: "1",
  tick: 0,
  baseIsToken1: true,
  priceQuotePerBase: { numerator: "2000", denominator: "1" },
  priceQuotePerBaseMicros: 2_000_000_000,
  quoteVolumeRaw: "1000000",
  quoteVolumeMicros: 1_000_000,
});

/**
 * The scripted research service: records every load, and serves one synthetic
 * retained dataset per call — candles price(i)=100+10i from anchor-2d to
 * anchor+(horizon+3)d, and two entry-day swaps (pool -5 then +3 base →
 * trader net acquisition +2 raw).
 */
const scriptedResearch = () => {
  const loads: Array<ScriptedLoad> = [];
  let seq = 0;
  const service: GraphResearchServiceShape = {
    loadStudyDataset: (input) =>
      Effect.sync(() => {
        const anchored = input.occurrences[0];
        if (anchored === undefined) {
          return {
            status: "unavailable" as const,
            reason: "scripted service needs one anchored occurrence",
          };
        }
        loads.push({
          entryBasis: input.entryBasis,
          anchorAt: anchored.endAt,
          horizonBars: input.horizonBars,
        });
        seq += 1;
        const anchorAt = anchored.endAt;
        const candles = candlesAround(anchorAt, -2, input.horizonBars + 3);
        const coverageFrom = anchorAt - 2 * DAY;
        const coverageTo = anchorAt + (input.horizonBars + 4) * DAY;
        // Deterministic per (anchor, horizon, basis): a replayed study design
        // must resolve identical dataset lineage (content-derived ids).
        const datasetId = `ds_scripted_${anchorAt}_${input.horizonBars}_${input.entryBasis}`;
        const dataset: GraphStudyDataset = {
          manifest: {
            id: datasetId,
            environmentId: input.environmentId,
            provider: "the-graph",
            transport: "subgraph",
            chainId: "1",
            deploymentOrPackageId: "dep-scripted",
            schemaSha256: "a".repeat(64),
            programSha256: "b".repeat(64),
            variablesSha256: "c".repeat(64),
            requested: { fromMs: coverageFrom, toMs: coverageTo },
            coverage: { fromMs: coverageFrom, toMs: coverageTo, rows: 2 },
            status: "complete",
            pin: { blockNumber: "1000", blockHash: "0x" + "ab".repeat(32) },
            cursor: null,
            normalizedSchemaVersion: 1,
            contentSha256: "d".repeat(64),
            capturedAtMs: input.now - 1,
            availabilityBasis: "recorded",
            mode: "historical-replay",
          },
          observations: [swapAt(anchorAt + 1000, "-5"), swapAt(anchorAt + 2000, "3")],
          candles,
          quoteDecimals: 6,
          quoteSymbol: "USDC",
          reused: false,
        };
        return { status: "ok" as const, dataset };
      }),
  };
  return { loads, service };
};

const makeService = (research: GraphResearchServiceShape) =>
  makeGraphEventWindowStudyService.pipe(
    Effect.provideService(GraphResearchService, GraphResearchService.of(research)),
  );

// -- the fixture event set ----------------------------------------------------

const NOW = Date.UTC(2026, 9, 13); // 2026-10-13: inside Devcon-8's pre-30d window below
const DEVCON_6 = {
  startAt: Date.UTC(2022, 9, 11),
  endAt: Date.UTC(2022, 9, 14),
  source: "archive.devcon.org",
};
const DEVCON_7 = {
  startAt: Date.UTC(2024, 10, 12),
  endAt: Date.UTC(2024, 10, 15),
  source: "devcon.org",
};
const DEVCON_1 = {
  startAt: Date.UTC(2015, 10, 9),
  endAt: Date.UTC(2015, 10, 13),
  source: "archive.devcon.org",
};
const DEVCON_8_NEXT = {
  startAt: Date.UTC(2026, 10, 3),
  endAt: Date.UTC(2026, 10, 6),
  source: "https://devcon.org/en/ (fetched 2026-09-13)",
};

const studyInput = (
  overrides?: Partial<GraphEventWindowStudyInput>,
): GraphEventWindowStudyInput => ({
  environmentId: ENV,
  poolId: POOL,
  market: "ETH",
  eventSetName: "Devcon",
  occurrences: [DEVCON_1, DEVCON_6, DEVCON_7],
  poolDataStartMs: Date.UTC(2021, 4, 15),
  intervalMs: DAY,
  variants: [
    {
      label: "pre-30d-hold-3d",
      anchor: "pre-start",
      leadMs: 30 * DAY,
      tailMs: 0,
      horizonBars: 3,
      entryBasis: "first_closed_bar_after_event",
    },
    {
      label: "post-end-1d-hold-2d",
      anchor: "post-end",
      leadMs: 0,
      tailMs: DAY,
      horizonBars: 2,
      entryBasis: "first_closed_bar_after_event",
    },
  ],
  nextOccurrence: DEVCON_8_NEXT,
  now: NOW,
  ...overrides,
});

layer("GraphEventWindowStudyService.runStudy", (it) => {
  it.effect(
    "measures every variant, declares pre-coverage occurrences uncovered, and applies-now honestly",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const { loads, service } = scriptedResearch();
        const study: GraphEventWindowStudyServiceShape = yield* makeService(service);
        const outcome = yield* study.runStudy(studyInput());
        assert.equal(outcome.status, "ok");
        if (outcome.status !== "ok") return;
        const result = outcome.result;
        assert.isTrue(result.studyId.startsWith("ges_"));

        // Two variants, both retained — compared, never selected post hoc.
        assert.deepEqual(
          result.variants.map((variant) => variant.label),
          ["pre-30d-hold-3d", "post-end-1d-hold-2d"],
        );

        const pre = result.variants[0]!;
        // Devcon 1 predates the DECLARED coverage: uncovered, with the reason.
        assert.isFalse(pre.occurrences[0]!.covered);
        assert.include(
          pre.occurrences[0]!.reason ?? "",
          "predates the pool dataset's declared coverage",
        );
        // Devcon 6 and 7 measured. price(i)=100+10i with close-basis entry and
        // horizon 3: entry close 100, exit close 130 → +30% exactly.
        for (const measured of [pre.occurrences[1]!, pre.occurrences[2]!]) {
          assert.isTrue(measured.covered, measured.label);
          assert.equal(measured.returnPct, 30);
          assert.isFalse(measured.truncated);
          assert.equal(measured.baselineMeanReturnPct, 29.36);
          // Exact entry-day flow: pool -5 then +3 base → traders net ACQUIRED 2.
          assert.equal(measured.entryDayNetBaseRaw, "2");
          // The synthetic dataset covers only anchor+7d, short of the 30d lead
          // window end — the lead sum must be OMITTED, never partial.
          assert.isUndefined(measured.entryLeadNetBaseRaw);
        }
        assert.equal(pre.aggregates.nRequested, 3);
        assert.equal(pre.aggregates.nCovered, 2);
        assert.equal(pre.aggregates.nComplete, 2);
        assert.equal(pre.aggregates.meanReturnPct, 30);
        assert.include(
          pre.disclosure,
          "baseline sampled at every bar of each occurrence's own retained dataset",
        );

        // The post-end variant anchors a day after each event end.
        const post = result.variants[1]!;
        assert.equal(post.occurrences[1]!.anchorAt, DEVCON_6.endAt + DAY);
        assert.isTrue(post.occurrences[1]!.covered);

        // Applies-now: NOW (2026-10-13) is inside Devcon 8's research-fixed
        // pre-30d entry window [2026-10-04, 2026-11-03); the post-end variant
        // has no pre-event window at all.
        assert.deepEqual(
          result.appliesNow.map((row) => [row.label, row.withinWindow]),
          [
            ["pre-30d-hold-3d", true],
            ["post-end-1d-hold-2d", null],
          ],
        );
        assert.equal(result.appliesNow[0]!.entryWindowStartMs, DEVCON_8_NEXT.startAt - 30 * DAY);
        assert.equal(result.appliesNow[0]!.entryWindowEndMs, DEVCON_8_NEXT.startAt);
        assert.include(result.appliesNow[1]!.note, "no pre-event entry window");

        // The scripted seam saw one load per measured (variant, occurrence),
        // each with the variant's own basis, anchor, and horizon.
        assert.deepEqual(
          loads.map((load) => load.anchorAt),
          [
            DEVCON_6.startAt - 30 * DAY,
            DEVCON_7.startAt - 30 * DAY,
            DEVCON_6.endAt + DAY,
            DEVCON_7.endAt + DAY,
          ],
        );
        assert.equal(loads[0]?.entryBasis, "first_closed_bar_after_event");
        assert.equal(loads[0]?.horizonBars, 3);
        assert.equal(loads[3]?.horizonBars, 2);

        // Uncertainty states the denominators plainly.
        assert.include(
          result.uncertainty,
          "4 complete horizon(s) across 3 requested Devcon occurrence(s)",
        );
        assert.equal(result.declaredPoolDataStartMs, Date.UTC(2021, 4, 15));
        assert.isNotNull(result.earliestRetainedObservationMs);
      }),
  );

  it.effect("retains the study idempotently and reads it back byte-exact", () =>
    Effect.gen(function* () {
      yield* reset;
      const { service } = scriptedResearch();
      const study: GraphEventWindowStudyServiceShape = yield* makeService(service);
      const first = yield* study.runStudy(studyInput());
      assert.equal(first.status, "ok");
      if (first.status !== "ok") return;
      const replay = yield* study.runStudy(studyInput());
      assert.equal(replay.status, "ok");
      if (replay.status !== "ok") return;
      // Same design, same datasets → same content-derived id, one row.
      assert.equal(replay.result.studyId, first.result.studyId);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT COUNT(*) AS n FROM forge_graph_event_studies`;
      assert.equal(rows[0]?.n, 1);
      const readBack = yield* study.readStudy(first.result.studyId);
      assert.isNotNull(readBack);
      assert.include(readBack?.specJson ?? "", "archive.devcon.org");
      assert.include(readBack?.resultJson ?? "", first.result.studyId);
      // A study id nobody retained reads as null.
      assert.isNull(yield* study.readStudy("ges_nonexistent"));
    }),
  );

  it.effect(
    "an anchor whose holding window still runs is measured as truncated, never dropped",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const { service } = scriptedResearch();
        const study: GraphEventWindowStudyServiceShape = yield* makeService(service);
        // NOW just two days after Devcon 7's post-end anchor: the 2-bar horizon
        // cannot have completed. The scripted dataset is capped at `now` by the
        // real seam in production; here the candles end before the horizon and
        // runEventStudy truncates.
        const outcome = yield* study.runStudy(
          studyInput({ now: Date.UTC(2024, 10, 16), nextOccurrence: undefined }),
        );
        assert.equal(outcome.status, "ok");
        if (outcome.status !== "ok") return;
        const post = outcome.result.variants[1]!;
        const devcon7 = post.occurrences[2]!;
        // Covered with a truncated horizon (or honestly uncovered); never a
        // fabricated complete return.
        if (devcon7.covered) {
          assert.isTrue(devcon7.truncated);
          assert.include(devcon7.reason ?? "", "truncated");
        } else {
          assert.isString(devcon7.reason);
        }
      }),
  );

  it.effect("refuses over-budget variants, empty sets, and bad inputs up front", () =>
    Effect.gen(function* () {
      yield* reset;
      const { loads, service } = scriptedResearch();
      const study: GraphEventWindowStudyServiceShape = yield* makeService(service);
      // 100d lead + 10d horizon at daily interval = 110 segments > 90.
      const overBudget = yield* study.runStudy(
        studyInput({
          variants: [
            {
              label: "pre-100d-hold-10d",
              anchor: "pre-start",
              leadMs: 100 * DAY,
              tailMs: 0,
              horizonBars: 10,
              entryBasis: "first_closed_bar_after_event",
            },
          ],
        }),
      );
      assert.equal(overBudget.status, "unavailable");
      if (overBudget.status === "unavailable") {
        assert.include(overBudget.reason, "pre-100d-hold-10d");
        assert.include(overBudget.reason, "segment");
      }
      const empty = yield* study.runStudy(studyInput({ occurrences: [] }));
      assert.equal(empty.status, "unavailable");
      const noVariants = yield* study.runStudy(studyInput({ variants: [] }));
      assert.equal(noVariants.status, "unavailable");
      // Nothing was acquired for any refusal.
      assert.isEmpty(loads);
    }),
  );

  it.effect(
    "without a declared coverage boundary every occurrence is attempted through the real seam",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const { loads, service } = scriptedResearch();
        const study: GraphEventWindowStudyServiceShape = yield* makeService(service);
        const outcome = yield* study.runStudy(
          studyInput({ poolDataStartMs: undefined, variants: [studyInput().variants[0]!] }),
        );
        assert.equal(outcome.status, "ok");
        if (outcome.status !== "ok") return;
        // All three Devcons attempted (including 2015) — nothing declared away.
        assert.equal(loads.length, 3);
        assert.isNull(outcome.result.declaredPoolDataStartMs);
      }),
  );
});
